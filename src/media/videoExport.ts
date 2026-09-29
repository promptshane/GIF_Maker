export interface VideoExportFrame {
  mediaTime: number;
}

export interface RenderAiVideoOptions {
  sourceUrl: string;
  frames: VideoExportFrame[];
  replacementUrls: Map<number, string>;
  fps: number;
  onProgress?: (progress: number) => void;
}

export interface RenderedVideo {
  blob: Blob;
  extension: 'mp4' | 'webm';
}

const MIME_TYPES = [
  'video/mp4;codecs=h264,aac',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('The source video took too long to load for export.'));
    }, 12_000);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('The source video could not be decoded for export.'));
    };

    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('One of the AI replacement images could not be decoded.'));
    image.src = url;
    if (image.complete && image.naturalWidth > 0) resolve(image);
  });
}

function frameIndexAtTime(frames: VideoExportFrame[], time: number): number {
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (frames[mid].mediaTime <= time + 0.0005) low = mid;
    else high = mid - 1;
  }
  return low;
}

function drawContained(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): void {
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    image,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function chooseMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function renderAiVideo(options: RenderAiVideoOptions): Promise<RenderedVideo> {
  const { sourceUrl, frames, replacementUrls, onProgress } = options;
  if (frames.length === 0) throw new Error('There are no video frames to export.');
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser cannot export a video file.');
  }

  const canvas = document.createElement('canvas');
  if (typeof canvas.captureStream !== 'function') {
    throw new Error('This browser cannot export a video from the edited frames.');
  }

  const source = document.createElement('video');
  source.src = sourceUrl;
  source.playsInline = true;
  source.preload = 'auto';
  source.style.position = 'fixed';
  source.style.left = '-9999px';
  source.style.width = '1px';
  source.style.height = '1px';
  source.setAttribute('aria-hidden', 'true');
  document.body.appendChild(source);

  let audioContext: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let callbackId = 0;

  try {
    source.load();
    await waitForVideoReady(source);
    if (typeof source.requestVideoFrameCallback !== 'function') {
      throw new Error('This browser cannot synchronize the edited frames for export.');
    }

    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not create the video export canvas.');

    const replacementImages = new Map<number, HTMLImageElement>();
    await Promise.all(
      [...replacementUrls.entries()].map(async ([index, url]) => {
        replacementImages.set(index, await loadImage(url));
      }),
    );

    const drawFrame = (index: number) => {
      const replacement = replacementImages.get(index);
      if (replacement) {
        drawContained(
          context,
          replacement,
          replacement.naturalWidth,
          replacement.naturalHeight,
          canvas.width,
          canvas.height,
        );
      } else {
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
      }
    };

    source.currentTime = Math.max(0, frames[0].mediaTime);
    await new Promise<void>((resolve, reject) => {
      if (source.readyState >= 2 && Math.abs(source.currentTime - frames[0].mediaTime) < 0.0005) {
        resolve();
        return;
      }
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('The source video took too long to seek for export.'));
      }, 8000);
      const cleanup = () => {
        window.clearTimeout(timer);
        source.removeEventListener('seeked', onSeeked);
        source.removeEventListener('error', onError);
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('The source video stopped decoding during export.'));
      };
      source.addEventListener('seeked', onSeeked, { once: true });
      source.addEventListener('error', onError, { once: true });
    });
    drawFrame(0);

    const frameRate = Math.max(1, Math.min(60, options.fps || 30));
    stream = canvas.captureStream(frameRate);

    // Route the original video's audio into the recording without playing it
    // through the device speakers. If Web Audio is unavailable, the export
    // still succeeds as a silent video.
    try {
      audioContext = new AudioContext();
      const sourceNode = audioContext.createMediaElementSource(source);
      const audioDestination = audioContext.createMediaStreamDestination();
      sourceNode.connect(audioDestination);
      for (const track of audioDestination.stream.getAudioTracks()) stream.addTrack(track);
      await audioContext.resume();
    } catch {
      if (audioContext) {
        await audioContext.close().catch(() => undefined);
        audioContext = null;
      }
    }

    const mimeType = chooseMimeType();
    const videoBitsPerSecond = Math.min(
      20_000_000,
      Math.max(5_000_000, Math.round(canvas.width * canvas.height * 6)),
    );
    recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType, videoBitsPerSecond } : { videoBitsPerSecond },
    );

    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    const stopped = new Promise<void>((resolve, reject) => {
      recorder?.addEventListener('stop', () => resolve(), { once: true });
      recorder?.addEventListener('error', () => reject(new Error('The video encoder stopped unexpectedly.')), {
        once: true,
      });
    });
    const ended = new Promise<void>((resolve, reject) => {
      source.addEventListener('ended', () => resolve(), { once: true });
      source.addEventListener('error', () => reject(new Error('The source video stopped decoding during export.')), {
        once: true,
      });
    });

    const onVideoFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      const index = frameIndexAtTime(frames, metadata.mediaTime);
      drawFrame(index);
      onProgress?.(Math.min(1, metadata.mediaTime / Math.max(source.duration, 0.001)));
      if (!source.ended) callbackId = source.requestVideoFrameCallback(onVideoFrame);
    };
    callbackId = source.requestVideoFrameCallback(onVideoFrame);

    recorder.start(250);
    await source.play();
    await ended;

    drawFrame(frames.length - 1);
    onProgress?.(1);
    await delay(Math.max(35, 1000 / frameRate));
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;

    if (chunks.length === 0) throw new Error('The video encoder did not produce a file.');
    const outputType = recorder.mimeType || mimeType || 'video/mp4';
    return {
      blob: new Blob(chunks, { type: outputType }),
      extension: outputType.includes('webm') ? 'webm' : 'mp4',
    };
  } finally {
    if (callbackId && typeof source.cancelVideoFrameCallback === 'function') {
      source.cancelVideoFrameCallback(callbackId);
    }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    source.pause();
    source.removeAttribute('src');
    source.load();
    source.remove();
    stream?.getTracks().forEach((track) => track.stop());
    if (audioContext) await audioContext.close().catch(() => undefined);
    canvas.width = 1;
    canvas.height = 1;
  }
}
