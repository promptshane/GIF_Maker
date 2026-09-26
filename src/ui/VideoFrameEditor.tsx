import { useCallback, useEffect, useRef, useState } from 'react';
import {
  frameFilename,
  frameIndexAtTime,
  frameIndexFromFilename,
  inferPresentedFps,
} from '../media/frameSequence';

const MAX_SECONDS = 10;
const THUMB_MAX_EDGE = 180;

type Phase = 'pick' | 'opening' | 'analysing' | 'ready';
type PlaybackMode = 'original' | 'ai';

interface FrameRecord {
  index: number;
  time: number;
  thumbBlob: Blob;
  thumbUrl: string;
}

interface AiFrame {
  url: string;
}

interface CallbackSample {
  time: number;
  presentedFrames: number;
  thumb: Promise<Blob>;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not create an image from this frame.'));
    }, type, quality);
  });
}

async function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.0005));
  if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 1e-4) return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('The video took too long to seek to that frame.'));
    }, 8000);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('The video stopped decoding while seeking.'));
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = target;
  });
}

function thumbCanvas(video: HTMLVideoElement): HTMLCanvasElement {
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
  return canvas;
}

function naturalNameSort(a: File, b: File): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

export function VideoFrameEditor({ onClose }: { onClose: () => void }) {
  const sourceInput = useRef<HTMLInputElement | null>(null);
  const bulkAiInput = useRef<HTMLInputElement | null>(null);
  const singleAiInput = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const aiPreviewRef = useRef<HTMLImageElement | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const framesRef = useRef<FrameRecord[]>([]);
  const aiFramesRef = useRef<Map<number, AiFrame>>(new Map());
  const modeRef = useRef<PlaybackMode>('original');
  const analysisToken = useRef(0);
  const singleTarget = useRef<number | null>(null);

  const [phase, setPhase] = useState<Phase>('pick');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [frames, setFrames] = useState<FrameRecord[]>([]);
  const [fps, setFps] = useState(0);
  const [fpsEstimated, setFpsEstimated] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<PlaybackMode>('original');
  const [aiFrames, setAiFrames] = useState<Map<number, AiFrame>>(new Map());
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busyFrame, setBusyFrame] = useState<number | null>(null);
  const [importingAi, setImportingAi] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  framesRef.current = frames;
  aiFramesRef.current = aiFrames;
  modeRef.current = mode;

  const revokeFrames = useCallback((items: FrameRecord[]) => {
    for (const frame of items) URL.revokeObjectURL(frame.thumbUrl);
  }, []);

  const revokeAi = useCallback((items: Map<number, AiFrame>) => {
    for (const frame of items.values()) URL.revokeObjectURL(frame.url);
  }, []);

  const clearProject = useCallback(() => {
    analysisToken.current += 1;
    videoRef.current?.pause();
    revokeFrames(framesRef.current);
    revokeAi(aiFramesRef.current);
    framesRef.current = [];
    aiFramesRef.current = new Map();
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
    setSourceFile(null);
    setSourceUrl(null);
    setFrames([]);
    setAiFrames(new Map());
    setFps(0);
    setFpsEstimated(false);
    setDimensions({ width: 0, height: 0 });
    setDuration(0);
    setProgress(0);
    setPlayhead(0);
    setPlaying(false);
    setMode('original');
    setMessage(null);
    setError(null);
    setPhase('pick');
  }, [revokeAi, revokeFrames]);

  useEffect(() => () => {
    analysisToken.current += 1;
    videoRef.current?.pause();
    revokeFrames(framesRef.current);
    revokeAi(aiFramesRef.current);
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
  }, [revokeAi, revokeFrames]);

  const updateAiPreview = useCallback((time: number) => {
    const image = aiPreviewRef.current;
    const list = framesRef.current;
    if (!image || list.length === 0) return;
    const index = frameIndexAtTime(list.map((frame) => frame.time), time);
    const src = aiFramesRef.current.get(index)?.url;
    if (!src) {
      image.style.visibility = 'hidden';
      return;
    }
    image.style.visibility = 'visible';
    if (image.dataset.frameSrc !== src) {
      image.dataset.frameSrc = src;
      image.src = src;
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || phase !== 'ready') return;
    let frameCallback = 0;
    let lastUi = 0;

    const update = (now: number, mediaTime: number) => {
      if (modeRef.current === 'ai') updateAiPreview(mediaTime);
      if (now - lastUi > 80) {
        lastUi = now;
        setPlayhead(mediaTime);
      }
    };

    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick: VideoFrameRequestCallback = (now, metadata) => {
        update(now, metadata.mediaTime);
        frameCallback = video.requestVideoFrameCallback(tick);
      };
      frameCallback = video.requestVideoFrameCallback(tick);
    }

    const onTime = () => {
      setPlayhead(video.currentTime);
      if (modeRef.current === 'ai') updateAiPreview(video.currentTime);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeked', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    return () => {
      if (frameCallback && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameCallback);
      }
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, [phase, updateAiPreview]);

  useEffect(() => {
    if (phase === 'ready' && mode === 'ai') updateAiPreview(videoRef.current?.currentTime ?? 0);
  }, [aiFrames, mode, phase, updateAiPreview]);

  const buildFallbackFrames = useCallback(async (
    video: HTMLVideoElement,
    token: number,
  ): Promise<{ frames: FrameRecord[]; fps: number }> => {
    const assumedFps = 30;
    const count = Math.max(1, Math.round(video.duration * assumedFps));
    const canvas = thumbCanvas(video);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas drawing is unavailable on this device.');
    const built: FrameRecord[] = [];
    for (let i = 0; i < count; i++) {
      if (token !== analysisToken.current) throw new Error('cancelled');
      const time = Math.min(video.duration - 0.0005, i / assumedFps);
      await seekVideo(video, time);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const thumbBlob = await canvasBlob(canvas, 'image/jpeg', 0.7);
      built.push({ index: i, time, thumbBlob, thumbUrl: URL.createObjectURL(thumbBlob) });
      setProgress((i + 1) / count);
    }
    return { frames: built, fps: assumedFps };
  }, []);

  const analyseCurrentVideo = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !sourceFile) return;
    const token = ++analysisToken.current;
    setError(null);
    setMessage(null);
    setPhase('analysing');
    setProgress(0);
    video.pause();

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      setPhase('pick');
      setError('This video does not report a usable duration.');
      return;
    }
    if (video.duration > MAX_SECONDS + 0.05) {
      setPhase('pick');
      setDuration(video.duration);
      setDimensions({ width: video.videoWidth, height: video.videoHeight });
      setError(`This workflow is limited to ${MAX_SECONDS}-second clips. Trim this clip first.`);
      return;
    }

    setDuration(video.duration);
    setDimensions({ width: video.videoWidth, height: video.videoHeight });
    revokeFrames(framesRef.current);
    setFrames([]);
    revokeAi(aiFramesRef.current);
    setAiFrames(new Map());

    try {
      if (typeof video.requestVideoFrameCallback !== 'function') {
        const fallback = await buildFallbackFrames(video, token);
        if (token !== analysisToken.current) return;
        setFrames(fallback.frames);
        setFps(fallback.fps);
        setFpsEstimated(true);
        setPhase('ready');
        setProgress(1);
        video.muted = false;
        await seekVideo(video, 0);
        return;
      }

      const canvas = thumbCanvas(video);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas drawing is unavailable on this device.');
      const samples: CallbackSample[] = [];
      video.muted = true;
      video.playbackRate = 1;
      await seekVideo(video, 0);

      await new Promise<void>((resolve, reject) => {
        let callbackId = 0;
        let done = false;
        let lastProgressAt = 0;
        const hardTimer = window.setTimeout(() => finish(new Error('Frame analysis timed out.')), 30_000);

        const cleanup = () => {
          window.clearTimeout(hardTimer);
          video.removeEventListener('ended', onEnded);
          video.removeEventListener('error', onError);
          if (callbackId && typeof video.cancelVideoFrameCallback === 'function') {
            video.cancelVideoFrameCallback(callbackId);
          }
        };
        const finish = (problem?: Error) => {
          if (done) return;
          done = true;
          cleanup();
          video.pause();
          if (problem) reject(problem);
          else resolve();
        };
        const onEnded = () => finish();
        const onError = () => finish(new Error('The video stopped decoding during frame analysis.'));
        const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
          if (token !== analysisToken.current) {
            finish(new Error('cancelled'));
            return;
          }
          const previous = samples[samples.length - 1];
          if (!previous || metadata.presentedFrames > previous.presentedFrames) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            samples.push({
              time: metadata.mediaTime,
              presentedFrames: metadata.presentedFrames,
              thumb: canvasBlob(canvas, 'image/jpeg', 0.7),
            });
            const now = performance.now();
            if (now - lastProgressAt > 90) {
              lastProgressAt = now;
              setProgress(Math.min(0.96, metadata.mediaTime / Math.max(0.001, video.duration)));
            }
          }
          if (!video.ended) callbackId = video.requestVideoFrameCallback(onFrame);
        };

        video.addEventListener('ended', onEnded, { once: true });
        video.addEventListener('error', onError, { once: true });
        callbackId = video.requestVideoFrameCallback(onFrame);
        void video.play().catch((problem) => finish(problem instanceof Error ? problem : new Error(String(problem))));
      });

      if (token !== analysisToken.current) return;
      if (samples.length === 0) throw new Error('No video frames were detected.');

      const basePresented = samples[0].presentedFrames;
      const lastPresented = samples[samples.length - 1].presentedFrames;
      const count = Math.max(1, lastPresented - basePresented + 1);
      const detectedFps = inferPresentedFps(samples);
      const times = new Array<number>(count);
      const thumbs = new Array<Blob | null>(count).fill(null);

      for (let s = 0; s < samples.length; s++) {
        const sample = samples[s];
        const ordinal = sample.presentedFrames - basePresented;
        if (ordinal >= 0 && ordinal < count) {
          times[ordinal] = sample.time;
          thumbs[ordinal] = await sample.thumb;
        }
        const next = samples[s + 1];
        if (!next) continue;
        const frameDelta = next.presentedFrames - sample.presentedFrames;
        if (frameDelta <= 1) continue;
        for (let step = 1; step < frameDelta; step++) {
          const missing = ordinal + step;
          if (missing >= count) break;
          times[missing] = sample.time + ((next.time - sample.time) * step) / frameDelta;
        }
      }

      const fallbackInterval = 1 / Math.max(1, detectedFps);
      for (let i = 0; i < count; i++) {
        if (!Number.isFinite(times[i])) {
          times[i] = i === 0 ? 0 : times[i - 1] + fallbackInterval;
        }
        times[i] = Math.min(video.duration - 0.0005, Math.max(0, times[i]));
      }

      // If WebKit skipped a callback while JS was busy, rVFC's presentedFrames
      // tells us exactly which ordinal is missing. Seek only those missing
      // thumbnails rather than re-decoding the whole clip.
      for (let i = 0; i < count; i++) {
        if (thumbs[i]) continue;
        await seekVideo(video, times[i]);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        thumbs[i] = await canvasBlob(canvas, 'image/jpeg', 0.7);
        setProgress(0.96 + ((i + 1) / count) * 0.04);
      }

      const built = thumbs.map((thumb, index) => {
        if (!thumb) throw new Error( Frame ${index + 1} could not be captured.`);
        return {
          index,
          time: times[index],
          thumbBlob: thumb,
          thumbUrl: URL.createObjectURL(thumb),
        };
      });

      if (token !== analysisToken.current) {
        revokeFrames(built);
        return;
      }
      setFrames(built);
      setFps(detectedFps);
      setFpsEstimated(false);
      setProgress(1);
      setPhase('ready');
      video.muted = false;
      await seekVideo(video, 0);
      setPlayhead(0);
    } catch (problem) {
      if (token !== analysisToken.current) return;
      const text = problem instanceof Error ? problem.message : String(problem);
      if (text !== 'cancelled') {
        setError(text);
        setPhase('opening');
      }
    }
  }, [buildFallbackFrames, revokeAi, revokeFrames, sourceFile]);

  const chooseSource = (file: File) => {
    analysisToken.current += 1;
    revokeFrames(framesRef.current);
    revokeAi(aiFramesRef.current);
    setFrames([]);
    setAiFrames(new Map());
    videoRef.current?.pause();
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    const url = URL.createObjectURL(file);
    sourceUrlRef.current = url;
    setSourceFile(file);
    setSourceUrl(url);
    setPhase('opening');
    setError(null);
    setMessage(null);
    setPlayhead(0);
    setFps(0);
    setProgress(0);
  };

  const downloadFrame = async (frame: FrameRecord) => {
    const video = videoRef.current;
    if (!video) return;
    setBusyFrame(frame.index);
    setError(null);
    const wasPlaying = !video.paused;
    const restoreTime = video.currentTime;
    video.pause();
    try {
      await seekVideo(video, frame.time);
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas drawing is unavailable on this device.');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas, 'image/png');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = frameFilename(frame.index);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusyFrame(null);
      try {
        await seekVideo(video, restoreTime);
        if (wasPlaying) await video.play();
      } catch {
        // The frame is already downloaded; failure to restore playback is harmless.
      }
    }
  };

  const assignAiFrame = (index: number, file: File) => {
    setAiFrames((current) => {
      const next = new Map(current);
      const old = next.get(index);
      if (old) URL.revokeObjectURL(old.url);
      next.set(index, { url: URL.createObjectURL(file) });
      aiFramesRef.current = next;
      return next;
    });
  };

  const importAiFiles = async (files: File[]) => {
    if (files.length === 0 || frames.length === 0) return;
    setImportingAi(true);
    setError(null);
    setMessage(null);
    try {
      const matches = new Map<number, File>();
      for (const file of files) {
        const index = frameIndexFromFilename(file.name, frames.length);
        if (index !== null) matches.set(index, file);
      }

      // Some AI tools replace filenames completely. If the user returns the
      // entire sequence, natural filename order is still a deterministic way
      // to restore it without making them rename hundreds of files.
      if (matches.size === 0 && files.length === frames.length) {
        [...files].sort(naturalNameSort).forEach((file, index) => matches.set(index, file));
      }

      if (matches.size === 0) {
        throw new Error('No frame numbers matched. Keep names like frame_000001.png, or replace a frame individually.');
      }

      setAiFrames((current) => {
        const next = new Map(current);
        for (const [index, file] of matches) {
          const old = next.get(index);
          if (old) URL.revokeObjectURL(old.url);
          next.set(index, { url: URL.createObjectURL(file) });
        }
        aiFramesRef.current = next;
        return next;
      });
      setMessage(`Matched ${matches.size} AI frame${matches.size === 1 ? '' : 's'} to the original sequence.`);
      setMode('ai');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setImportingAi(false);
    }
  };

  const playPause = () => {
    const video = videoRef.current;
    if (!video || phase !== 'ready') return;
    if (video.ended || video.currentTime >= video.duration - 0.02) video.currentTime = 0;
    if (video.paused) void video.play();
    else video.pause();
  };

  const matched = aiFrames.size;
  const fpsLabel = fps ? `${fps.toFixed(Number.isInteger(fps) ? 0 : 2)} FPS${fpsEstimated ? ' est.' : ''}` : '—';

  return (
    <div className="frame-editor">
      <header className="topbar">
        <button type="button" className="icon-only" aria-label="Back to editor choices" onClick={onClose}>‹</button>
        <h1>Video Frames</h1>
        {sourceFile ? (
          <button type="button" className="topbar-cta frame-new-btn" onClick={clearProject}>New</button>
        ) : <span className="frame-topbar-spacer" />}
      </header>

      {error && (
        <div className="banner frame-banner">
          <div className="grow">{error}</div>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {phase === 'pick' ? (
        <main className="frame-pick">
          <div className="import-hero">
            <div className="hero-mark" aria-hidden="true">▦</div>
            <h2>Edit Video</h2>
            <p>Split a short clip into frames, edit them elsewhere, then compare the original and AI sequence.</p>
          </div>
          <button type="button" className="cta" onClick={() => sourceInput.current?.click()}>Choose Video</button>
          <p className="fineprint">Up to {MAX_SECONDS} seconds · processed entirely on this device</p>
        </main>
      ) : (
        <main className="frame-workspace">
          <section className="frame-player-card">
            <div className="frame-player" style={dimensions.width && dimensions.height ? { aspectRatio: `${dimensions.width} / ${dimensions.height}` } : undefined}>
              {sourceUrl && (
                <video
                  ref={videoRef}
                  src={sourceUrl}
                  playsInline
                  preload="auto"
                  className={`frame-source-video${mode === 'ai' ? ' ai-clock' : ''}`}
                  onLoadedMetadata={() => void analyseCurrentVideo()}
                />
              )}
              <img
                ref={aiPreviewRef}
                className={`frame-ai-preview${mode === 'ai' && phase === 'ready' ? ' visible' : ''}`}
                alt="AI frame sequence preview"
              />
              {(phase === 'opening' || phase === 'analysing') && (
                <div className="frame-analyse-overlay">
                  <div className="spinner" />
                  <strong>{phase === 'opening' ? 'Opening video…' : 'Reading every frame…'}</strong>
                  {phase === 'analysing' && (
                    <div className="progress-track frame-analysis-progress">
                      <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
                    </div>
                  )}
                </div>
              )}
            </div>

            {phase === 'ready' && (
              <>
                <div className="frame-mode-switch segmented">
                  <button type="button" aria-pressed={mode === 'original'} onClick={() => setMode('original')}>Original</button>
                  <button type="button" aria-pressed={mode === 'ai'} onClick={() => setMode('ai')}>AI {matched ? `(${matched})` : ''}</button>
                </div>
                <div className="frame-transport">
                  <button type="button" className="play-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={playPause}>{playing ? 'Ⅱ' : '▶'}</button>
                  <input
                    className="scrub"
                    type="range"
                    min={0}
                    max={Math.max(0.001, duration)}
                    step={0.001}
                    value={Math.min(playhead, duration)}
                    onChange={(event) => {
                      const time = Number(event.target.value);
                      const video = videoRef.current;
                      setPlayhead(time);
                      if (video) video.currentTime = time;
                      if (mode === 'ai') updateAiPreview(time);
                    }}
                  />
                  <span className="transport-time">{playhead.toFixed(2)} / {duration.toFixed(2)}s</span>
                </div>
              </>
            )}
          </section>

          {phase === 'ready' && (
            <>
              <section className="frame-summary">
                <div><span>FPS</span><strong>{fpsLabel}</strong></div>
                <div><span>Frames</span><strong>{frames.length}</strong></div>
                <div><span>Resolution</span><strong>{dimensions.width}×{dimensions.height}</strong></div>
                <div><span>Duration</span><strong>{duration.toFixed(2)}s</strong></div>
              </section>

              <section className="frame-ai-actions">
                <button type="button" className="cta" disabled={importingAi} onClick={() => bulkAiInput.current?.click()}>
                  {importingAi ? 'Importing…' : 'Import AI Frames'}
                </button>
                {matched > 0 && (
                  <button type="button" className="ghost-btn" onClick={() => {
                    revokeAi(aiFramesRef.current);
                    aiFramesRef.current = new Map();
                    setAiFrames(new Map());
                    setMode('original');
                    setMessage(null);
                  }}>Clear AI Frames</button>
                )}
                <p className="hint">Downloaded names contain the frame number. Re-import those files and they match automatically; you can also replace any frame individually below.</p>
                {message && <p className="frame-success">{message}</p>}
              </section>

              <section className="frame-grid" aria-label="Video frames">
                {frames.map((frame) => {
                  const ai = aiFrames.get(frame.index);
                  return (
                    <article key={frame.index} className={`frame-card${ai ? ' has-ai' : ''}`}>
                      <button
                        type="button"
                        className="frame-thumb-button"
                        onClick={() => {
                          const video = videoRef.current;
                          video?.pause();
                          if (video) video.currentTime = frame.time;
                          setPlayhead(frame.time);
                          if (mode === 'ai') updateAiPreview(frame.time);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        aria-label={`Preview frame ${frame.index + 1}`}
                      >
                        <img src={ai?.url ?? frame.thumbUrl} alt={`Frame ${frame.index + 1}`} loading="lazy" />
                        {ai && <span className="frame-ai-badge">AI</span>}
                      </button>
                      <div className="frame-card-meta">
                        <span>#{String(frame.index + 1).padStart(3, '0')}</span>
                        <span>{frame.time.toFixed(3)}s</span>
                      </div>
                      <div className="frame-card-actions">
                        <button type="button" disabled={busyFrame !== null} onClick={() => void downloadFrame(frame)}>
                          {busyFrame === frame.index ? 'Saving…' : 'Download'}
                        </button>
                        <button type="button" onClick={() => {
                          singleTarget.current = frame.index;
                          singleAiInput.current?.click();
                        }}>{ai ? 'Replace AI' : 'Add AI'}</button>
                      </div>
                    </article>
                  );
                })}
              </section>
            </>
          )}
        </main>
      )}

      <input
        ref={sourceInput}
        type="file"
        accept="video/*,.mov,.mp4,.m4v"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) chooseSource(file);
        }}
      />
      <input
        ref={bulkAiInput}
        type="file"
        accept="image/*,.png,.jpg,.jpeg,.webp"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          void importAiFiles(files);
        }}
      />
      <input
        ref={singleAiInput}
        type="file"
        accept="image/*,.png,.jpg,.jpeg,.webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          const target = singleTarget.current;
          singleTarget.current = null;
          if (file && target !== null) {
            assignAiFrame(target, file);
            setMode('ai');
            setMessage(`AI image assigned to frame ${target + 1}.`);
          }
        }}
      />
    </div>
  );
}
