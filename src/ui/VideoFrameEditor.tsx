import { useEffect, useMemo, useRef, useState } from 'react';
import { uid } from '../lib/format';
import {
  isEphemeralStorageError,
  isQuotaError,
  requestPersistence,
} from '../state/projectsDb';
import {
  deleteVideoFrameProject,
  getVideoFrameProject,
  listVideoFrameProjects,
  putVideoFrameProject,
  videoFrameProjectsSupported,
  type SavedVideoFrameProjectMeta,
  type StoredVideoFrameReplacement,
} from '../state/videoFrameProjectsDb';
import { Sheet } from './common';
import './videoFrames.css';

interface ExtractedFrame {
  index: number;
  mediaTime: number;
  thumbUrl: string;
}

interface ReplacementFrame {
  file: File;
  url: string;
}

interface PendingRestore {
  id: string;
  name: string;
  replacements: Array<{ index: number; file: File }>;
}

type ViewMode = 'original' | 'ai';

const MAX_SECONDS = 10;
const THUMB_LONG_EDGE = 180;
const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

function frameFilename(index: number): string {
  return 'frame_' + String(index + 1).padStart(6, '0') + '.png';
}

function detectFrameNumber(name: string): number | null {
  const match = name.match(/frame[^0-9]*0*([0-9]+)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value - 1 : null;
}

function defaultProjectName(file: File): string {
  const stem = file.name.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  return stem || 'Video project';
}

function nearestStandardFps(value: number): number {
  let best = value;
  let distance = Number.POSITIVE_INFINITY;
  for (const fps of STANDARD_FPS) {
    const delta = Math.abs(value - fps);
    if (delta < distance) {
      best = fps;
      distance = delta;
    }
  }
  return distance <= Math.max(0.08, value * 0.004) ? best : value;
}

function estimateFps(frames: ExtractedFrame[]): number {
  if (frames.length < 2) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const delta = frames[i].mediaTime - frames[i - 1].mediaTime;
    if (delta > 0.001 && delta < 0.2) deltas.push(delta);
  }
  if (deltas.length === 0) return 0;
  deltas.sort((a, b) => a - b);
  const middle = Math.floor(deltas.length / 2);
  const median = deltas.length % 2 === 0
    ? (deltas[middle - 1] + deltas[middle]) / 2
    : deltas[middle];
  return nearestStandardFps(1 / median);
}

function formatFps(value: number): string {
  if (!value) return '—';
  return Math.abs(value - Math.round(value)) < 0.01 ? String(Math.round(value)) : value.toFixed(2);
}

function findFrameIndex(frames: ExtractedFrame[], time: number): number {
  if (frames.length === 0) return 0;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (frames[mid].mediaTime <= time + 0.0005) low = mid;
    else high = mid - 1;
  }
  return low;
}

function waitForSeek(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.0005));
  if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.0005) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('The video took too long to seek.'));
    }, 8000);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      window.setTimeout(resolve, 35);
    };
    const onError = () => {
      cleanup();
      reject(new Error('The video stopped decoding.'));
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = target;
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('The frame could not be encoded.')),
      'image/png',
    );
  });
}

export function VideoFrameEditor() {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const aiInput = useRef<HTMLInputElement | null>(null);
  const singleAiInput = useRef<HTMLInputElement | null>(null);
  const singleAiTarget = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const replacementUrls = useRef(new Set<string>());
  const pendingRestore = useRef<PendingRestore | null>(null);
  const scanToken = useRef(0);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [frames, setFrames] = useState<ExtractedFrame[]>([]);
  const [fps, setFps] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [replacements, setReplacements] = useState<Map<number, ReplacementFrame>>(() => new Map());
  const [viewMode, setViewMode] = useState<ViewMode>('original');
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const [savedProjects, setSavedProjects] = useState<SavedVideoFrameProjectMeta[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [savingProject, setSavingProject] = useState(false);

  async function refreshSavedProjects(): Promise<void> {
    if (!videoFrameProjectsSupported()) return;
    setProjectsLoading(true);
    try {
      setSavedProjects(await listVideoFrameProjects());
    } catch {
      setSavedProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }

  useEffect(() => {
    void refreshSavedProjects();
  }, []);

  useEffect(() => {
    return () => {
      scanToken.current += 1;
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      for (const url of replacementUrls.current) URL.revokeObjectURL(url);
      replacementUrls.current.clear();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || frames.length === 0) return;

    let raf = 0;
    const tick = () => {
      setCurrentFrame(findFrameIndex(frames, video.currentTime));
      if (!video.paused && !video.ended) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      tick();
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrentFrame(Math.max(0, frames.length - 1));
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
    };
  }, [frames]);

  const clearReplacementUrls = () => {
    for (const url of replacementUrls.current) URL.revokeObjectURL(url);
    replacementUrls.current.clear();
    setReplacements(new Map());
  };

  const chooseVideo = (file: File, restore: PendingRestore | null = null) => {
    scanToken.current += 1;
    videoRef.current?.pause();
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    clearReplacementUrls();

    const url = URL.createObjectURL(file);
    videoUrlRef.current = url;
    pendingRestore.current = restore;
    setVideoUrl(url);
    setVideoFile(file);
    setFrames([]);
    setFps(0);
    setCurrentFrame(0);
    setViewMode('original');
    setScanning(false);
    setScanProgress(0);
    setProjectId(restore?.id ?? null);
    setProjectName(restore?.name ?? null);
    setNotice(restore ? 'Opening saved project…' : '');
    setError('');
  };

  const scanVideo = async () => {
    const video = videoRef.current;
    if (!video || !videoUrl) return;

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      setError('This video does not report a usable duration.');
      return;
    }
    if (video.duration > MAX_SECONDS + 0.05) {
      setError('Please use a clip that is 10 seconds or shorter.');
      return;
    }
    if (typeof video.requestVideoFrameCallback !== 'function') {
      setError('This browser cannot enumerate the video frames reliably. Open the installed app on a current iPhone/iPad or Safari version.');
      return;
    }

    const token = ++scanToken.current;
    setScanning(true);
    setFrames([]);
    setFps(0);
    setScanProgress(0);
    setCurrentFrame(0);
    setNotice('');
    setError('');

    try {
      video.pause();
      video.muted = true;
      await waitForSeek(video, 0);

      const scale = Math.min(1, THUMB_LONG_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Could not create the frame canvas.');

      const captured: ExtractedFrame[] = [];
      let callbackId = 0;
      let lastPresented = -1;
      let settled = false;
      let resolveDone: (() => void) | null = null;
      let rejectDone: ((reason?: unknown) => void) | null = null;

      const cleanup = () => {
        video.removeEventListener('ended', onEnded);
        video.removeEventListener('error', onError);
        if (callbackId) video.cancelVideoFrameCallback(callbackId);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveDone?.();
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectDone?.(new Error('The video stopped decoding while frames were being read.'));
      };
      const onEnded = () => window.setTimeout(finish, 40);
      const onError = () => fail();

      const capture = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (settled || token !== scanToken.current) {
          finish();
          return;
        }

        if (metadata.presentedFrames !== lastPresented) {
          lastPresented = metadata.presentedFrames;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          captured.push({
            index: captured.length,
            mediaTime: metadata.mediaTime,
            thumbUrl: canvas.toDataURL('image/jpeg', 0.72),
          });
          setScanProgress(Math.min(1, metadata.mediaTime / Math.max(video.duration, 0.001)));
          if (captured.length % 12 === 0) setFrames([...captured]);
        }
        callbackId = video.requestVideoFrameCallback(capture);
      };

      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
        video.addEventListener('ended', onEnded, { once: true });
        video.addEventListener('error', onError, { once: true });
        callbackId = video.requestVideoFrameCallback(capture);
      });

      try {
        await video.play();
      } catch {
        cleanup();
        throw new Error('Frame scanning could not start. Tap Scan frames and try again.');
      }
      await done;

      if (token !== scanToken.current) return;
      if (captured.length === 0) throw new Error('No video frames were detected.');

      captured.sort((a, b) => a.mediaTime - b.mediaTime);
      const unique = captured.filter((frame, index) =>
        index === 0 || frame.mediaTime - captured[index - 1].mediaTime > 0.0001
      );
      unique.forEach((frame, index) => {
        frame.index = index;
      });

      const detectedFps = estimateFps(unique);
      setFrames(unique);
      setFps(detectedFps);
      setScanProgress(1);

      const restore = pendingRestore.current;
      if (restore) {
        const restored = new Map<number, ReplacementFrame>();
        for (const item of restore.replacements) {
          if (item.index < 0 || item.index >= unique.length) continue;
          const url = URL.createObjectURL(item.file);
          replacementUrls.current.add(url);
          restored.set(item.index, { file: item.file, url });
        }
        setReplacements(restored);
        setViewMode(restored.size > 0 ? 'ai' : 'original');
        setNotice(
          'Restored ' + restore.name + ' · ' + restored.size + ' AI frame' +
          (restored.size === 1 ? '' : 's') + '.'
        );
        pendingRestore.current = null;
      } else {
        setNotice(
          'Detected ' + unique.length + ' frames at ' + formatFps(detectedFps) +
          ' FPS. Tap any frame to inspect, download, or add its AI replacement.'
        );
      }

      video.pause();
      await waitForSeek(video, 0);
      setCurrentFrame(0);
    } catch (cause) {
      if (token !== scanToken.current) return;
      setError(cause instanceof Error ? cause.message : 'The video could not be scanned.');
    } finally {
      if (token === scanToken.current) setScanning(false);
    }
  };

  const selectFrame = async (index: number) => {
    const video = videoRef.current;
    const frame = frames[index];
    if (!video || !frame) return;
    video.pause();
    setCurrentFrame(index);
    try {
      await waitForSeek(video, frame.mediaTime);
    } catch {
      // The thumbnail still provides a useful selection if an isolated seek fails.
    }
  };

  const downloadFrame = async (index: number) => {
    const video = videoRef.current;
    const frame = frames[index];
    if (!video || !frame) return;

    video.pause();
    setSavingIndex(index);
    setError('');
    try {
      await waitForSeek(video, frame.mediaTime);
      setCurrentFrame(index);

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Could not create the export canvas.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToPng(canvas);
      const name = frameFilename(index);
      const file = new File([blob], name, { type: 'image/png' });

      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name });
          return;
        } catch (shareError) {
          if (shareError instanceof DOMException && shareError.name === 'AbortError') return;
        }
      }

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That frame could not be downloaded.');
    } finally {
      setSavingIndex(null);
    }
  };

  const assignAiFrame = (index: number, file: File) => {
    if (index < 0 || index >= frames.length) return;
    setReplacements((current) => {
      const next = new Map(current);
      const previous = next.get(index);
      if (previous) {
        URL.revokeObjectURL(previous.url);
        replacementUrls.current.delete(previous.url);
      }
      const url = URL.createObjectURL(file);
      replacementUrls.current.add(url);
      next.set(index, { file, url });
      return next;
    });
    setCurrentFrame(index);
    setViewMode('ai');
    setError('');
    setNotice(
      'AI image assigned to frame ' + String(index + 1).padStart(3, '0') +
      '. Save the project when you want to keep this change.'
    );
  };

  const chooseAiForFrame = (index: number) => {
    singleAiTarget.current = index;
    setCurrentFrame(index);
    singleAiInput.current?.click();
    void selectFrame(index);
  };

  const importAiFrames = (files: File[]) => {
    if (frames.length === 0 || files.length === 0) return;

    const imageFiles = files.filter((file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name));
    const explicit = new Map<number, File>();
    for (const file of imageFiles) {
      const index = detectFrameNumber(file.name);
      if (index !== null && index >= 0 && index < frames.length) explicit.set(index, file);
    }

    const assignments = new Map<number, File>();
    if (explicit.size > 0) {
      for (const [index, file] of explicit) assignments.set(index, file);
    } else if (imageFiles.length === frames.length) {
      const sorted = [...imageFiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      sorted.forEach((file, index) => assignments.set(index, file));
    } else {
      setError(
        'Could not match those images automatically. You can instead select any frame and tap Add AI for selected frame.'
      );
      return;
    }

    setReplacements((current) => {
      const next = new Map(current);
      for (const [index, file] of assignments) {
        const previous = next.get(index);
        if (previous) {
          URL.revokeObjectURL(previous.url);
          replacementUrls.current.delete(previous.url);
        }
        const url = URL.createObjectURL(file);
        replacementUrls.current.add(url);
        next.set(index, { file, url });
      }
      return next;
    });
    setViewMode('ai');
    setError('');
    setNotice(
      'Imported ' + assignments.size + ' AI frame' + (assignments.size === 1 ? '' : 's') +
      '. Save the project when you want to keep these changes.'
    );
  };

  const openSaveSheet = () => {
    if (!videoFile) return;
    setSaveName(projectName ?? defaultProjectName(videoFile));
    setSaveOpen(true);
  };

  const saveCurrentProject = async () => {
    if (!videoFile || frames.length === 0) return;
    const name = saveName.trim() || defaultProjectName(videoFile);
    const id = projectId ?? uid();
    setSavingProject(true);
    setError('');

    try {
      const storedReplacements: StoredVideoFrameReplacement[] = [...replacements.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, replacement]) => ({
          index,
          name: replacement.file.name,
          type: replacement.file.type,
          blob: replacement.file,
        }));

      const bytes = videoFile.size + storedReplacements.reduce((sum, item) => sum + item.blob.size, 0);
      const savedAt = Date.now();
      await putVideoFrameProject(
        {
          id,
          name,
          savedAt,
          videoName: videoFile.name,
          bytes,
          frameCount: frames.length,
          replacementCount: storedReplacements.length,
        },
        {
          id,
          version: 1,
          video: {
            name: videoFile.name,
            type: videoFile.type,
            blob: videoFile,
          },
          replacements: storedReplacements,
        },
      );
      void requestPersistence();
      setProjectId(id);
      setProjectName(name);
      setSaveOpen(false);
      setNotice('Saved ' + name + ' with ' + storedReplacements.length + ' AI frame' +
        (storedReplacements.length === 1 ? '' : 's') + '.');
      await refreshSavedProjects();
    } catch (cause) {
      setError(
        isQuotaError(cause)
          ? 'There is not enough device storage to save this project.'
          : isEphemeralStorageError(cause)
            ? 'Video projects cannot be saved in Private Browsing.'
            : cause instanceof Error
              ? cause.message
              : 'The video project could not be saved.'
      );
    } finally {
      setSavingProject(false);
    }
  };

  const openSavedProject = async (meta: SavedVideoFrameProjectMeta) => {
    setOpeningProjectId(meta.id);
    setError('');
    try {
      const data = await getVideoFrameProject(meta.id);
      if (!data) throw new Error('That saved project is no longer available.');
      const file = new File([data.video.blob], data.video.name, { type: data.video.type });
      const restore: PendingRestore = {
        id: meta.id,
        name: meta.name,
        replacements: data.replacements.map((item) => ({
          index: item.index,
          file: new File([item.blob], item.name, { type: item.type }),
        })),
      };
      chooseVideo(file, restore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The saved project could not be opened.');
    } finally {
      setOpeningProjectId(null);
    }
  };

  const removeSavedProject = async (meta: SavedVideoFrameProjectMeta) => {
    if (!confirm('Delete “' + meta.name + '”? This cannot be undone.')) return;
    try {
      await deleteVideoFrameProject(meta.id);
      await refreshSavedProjects();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The saved project could not be deleted.');
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || frames.length === 0 || scanning) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    if (video.ended || currentFrame >= frames.length - 1) {
      video.currentTime = frames[0].mediaTime;
      setCurrentFrame(0);
    }
    void video.play().catch(() => setError('Playback could not start.'));
  };

  const activeAiUrl = useMemo(() => {
    if (viewMode !== 'ai' || frames.length === 0) return null;
    return replacements.get(currentFrame)?.url ?? frames[currentFrame]?.thumbUrl ?? null;
  }, [viewMode, replacements, currentFrame, frames]);

  const missingAiFrames = Math.max(0, frames.length - replacements.size);
  const currentHasAi = replacements.has(currentFrame);

  return (
    <div className="video-frame-editor">
      {!videoUrl ? (
        <div className="frame-import">
          <div className="import-hero">
            <div className="hero-mark" aria-hidden="true">▦</div>
            <h2>Edit Video</h2>
            <p>Choose a clip up to 10 seconds. Every frame stays on this device.</p>
          </div>
          <button type="button" className="pick" onClick={() => fileInput.current?.click()}>
            <span className="pick-icon" aria-hidden="true">🎬</span>
            <span className="grow">
              <span className="pick-title">Choose video</span>
              <span className="pick-sub">MOV, MP4, M4V, or any video Safari can play.</span>
            </span>
          </button>
          <p className="fineprint">The app scans the clip at normal speed to identify every displayed source frame accurately.</p>

          {videoFrameProjectsSupported() && (
            <section className="frame-saved-projects">
              <div className="frame-saved-head">
                <h3>Saved video projects</h3>
                {projectsLoading && <span>Loading…</span>}
              </div>
              {!projectsLoading && savedProjects.length === 0 && (
                <p className="frame-saved-empty">No saved video projects yet.</p>
              )}
              {savedProjects.map((project) => (
                <div className="frame-saved-row" key={project.id}>
                  <button
                    type="button"
                    className="frame-saved-open"
                    disabled={openingProjectId !== null}
                    onClick={() => void openSavedProject(project)}
                  >
                    <span className="frame-saved-name">{project.name}</span>
                    <span className="frame-saved-meta">
                      {project.frameCount} frames · {project.replacementCount} AI · {new Date(project.savedAt).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="frame-saved-delete"
                    aria-label={'Delete ' + project.name}
                    onClick={() => void removeSavedProject(project)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </section>
          )}

          {error && <div className="frame-error">{error}</div>}
        </div>
      ) : (
        <>
          <section className="frame-preview-section">
            <div className="frame-video-wrap">
              <video
                ref={videoRef}
                src={videoUrl}
                playsInline
                muted
                preload="auto"
                onLoadedMetadata={() => void scanVideo()}
              />
              {activeAiUrl && (
                <img className="frame-ai-overlay" src={activeAiUrl} alt="AI replacement frame preview" />
              )}
              {scanning && (
                <div className="frame-scan-overlay">
                  <strong>{pendingRestore.current ? 'Reopening project…' : 'Reading frames…'}</strong>
                  <span>{Math.round(scanProgress * 100)}%</span>
                </div>
              )}
            </div>

            {frames.length > 0 && (
              <>
                <div className="frame-mode-switch" role="group" aria-label="Preview source">
                  <button type="button" aria-pressed={viewMode === 'original'} onClick={() => setViewMode('original')}>
                    Original
                  </button>
                  <button type="button" aria-pressed={viewMode === 'ai'} onClick={() => setViewMode('ai')}>
                    AI {replacements.size ? '(' + replacements.size + ')' : ''}
                  </button>
                </div>

                <div className="frame-transport">
                  <button type="button" className="play-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
                    {playing ? 'Ⅱ' : '▶'}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, frames.length - 1)}
                    value={currentFrame}
                    step={1}
                    aria-label="Current frame"
                    onChange={(event) => void selectFrame(Number(event.target.value))}
                  />
                  <span className="frame-counter">
                    {currentFrame + 1} / {frames.length}
                  </span>
                </div>

                <div className="frame-metadata">
                  <span><strong>{formatFps(fps)}</strong> FPS</span>
                  <span><strong>{frames.length}</strong> frames</span>
                  <span><strong>{videoRef.current ? videoRef.current.videoWidth + '×' + videoRef.current.videoHeight : '—'}</strong></span>
                  {projectName && <span><strong>{projectName}</strong></span>}
                </div>
              </>
            )}
          </section>

          <section className="frame-actions-panel">
            <div className="frame-action-row">
              <button type="button" className="ghost-btn" onClick={() => fileInput.current?.click()}>
                Change video
              </button>
              {frames.length > 0 && videoFrameProjectsSupported() && (
                <button type="button" className="ghost-btn frame-save-project" onClick={openSaveSheet}>
                  {projectId ? 'Save changes' : 'Save project'}
                </button>
              )}
            </div>

            {frames.length > 0 && (
              <div className="frame-action-row frame-ai-action-row">
                <button type="button" className="cta frame-selected-ai" onClick={() => chooseAiForFrame(currentFrame)}>
                  {currentHasAi ? 'Replace AI' : 'Add AI'} for frame #{String(currentFrame + 1).padStart(3, '0')}
                </button>
                <button type="button" className="ghost-btn frame-bulk-ai" onClick={() => aiInput.current?.click()}>
                  Bulk import
                </button>
              </div>
            )}

            {viewMode === 'ai' && replacements.size > 0 && (
              <div className="hint">
                {missingAiFrames === 0
                  ? 'All frames have AI replacements.'
                  : missingAiFrames + ' frame' + (missingAiFrames === 1 ? '' : 's') + ' still use the original preview.'}
              </div>
            )}
            {notice && <div className="frame-notice">{notice}</div>}
            {error && <div className="frame-error">{error}</div>}
          </section>

          {frames.length > 0 && (
            <section className="frame-browser">
              <div className="frame-browser-head">
                <div>
                  <h2>Frames</h2>
                  <p>Tap a frame to select it. Download the original or attach its AI replacement directly.</p>
                </div>
                <strong>{frames.length}</strong>
              </div>

              <div className="frame-grid">
                {frames.map((frame, index) => (
                  <article
                    key={frame.index}
                    className={'frame-card' + (index === currentFrame ? ' selected' : '')}
                  >
                    <button
                      type="button"
                      className="frame-thumb-button"
                      onClick={() => void selectFrame(index)}
                      aria-label={'View frame ' + (index + 1)}
                    >
                      <img src={frame.thumbUrl} alt={'Frame ' + (index + 1)} loading="lazy" />
                      <span className="frame-number">{String(index + 1).padStart(3, '0')}</span>
                      {replacements.has(index) && <span className="frame-ai-badge">AI</span>}
                    </button>
                    <div className="frame-card-actions">
                      <button
                        type="button"
                        className="frame-download"
                        disabled={savingIndex !== null}
                        onClick={() => void downloadFrame(index)}
                      >
                        {savingIndex === index ? 'Saving…' : 'Download'}
                      </button>
                      <button
                        type="button"
                        className="frame-add-ai"
                        onClick={() => chooseAiForFrame(index)}
                      >
                        {replacements.has(index) ? 'Replace AI' : 'Add AI'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="video/*,.mov,.mp4,.m4v"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) chooseVideo(file);
        }}
      />
      <input
        ref={aiInput}
        type="file"
        accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) importAiFrames(files);
        }}
      />
      <input
        ref={singleAiInput}
        type="file"
        accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          const target = singleAiTarget.current;
          singleAiTarget.current = null;
          if (file && target !== null) assignAiFrame(target, file);
        }}
      />

      <Sheet open={saveOpen} onClose={() => setSaveOpen(false)} labelledBy="video-frame-save-title">
        <h2 id="video-frame-save-title">{projectId ? 'Save changes' : 'Save video project'}</h2>
        <p className="sheet-sub">
          Keeps the original clip and your AI replacement images on this device so you can continue later.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveCurrentProject();
          }}
        >
          <input
            type="text"
            value={saveName}
            aria-label="Project name"
            placeholder="Project name"
            autoComplete="off"
            enterKeyHint="done"
            onChange={(event) => setSaveName(event.target.value)}
            onFocus={(event) => event.target.select()}
          />
          <button type="submit" className="cta" style={{ marginTop: 14 }} disabled={savingProject}>
            {savingProject ? 'Saving…' : projectId ? 'Save changes' : 'Save'}
          </button>
        </form>
        <div className="hint">
          Extracted thumbnails are rebuilt from the original clip when you reopen the project, so they do not waste storage.
        </div>
      </Sheet>
    </div>
  );
}
