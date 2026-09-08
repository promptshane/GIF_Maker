import { MediaError } from './errors';

/**
 * Above this we warn rather than block: Safari streams from the object URL, so
 * large files are usually fine, but decode failures become much more likely.
 */
export const LARGE_VIDEO_BYTES = 350 * 1024 * 1024;

/** Guard against an accidental hour-long import producing an unusable timeline. */
export const MAX_VIDEO_SECONDS = 10 * 60;

/**
 * `requestVideoFrameCallback` is in the DOM typings but is genuinely optional at
 * runtime — older WebKit builds and some embedded webviews do not ship it.
 */
const hasFrameCallback = (video: HTMLVideoElement): boolean =>
  typeof (video as Partial<HTMLVideoElement>).requestVideoFrameCallback === 'function';

/**
 * Seek-based video frame reader.
 *
 * We deliberately do *not* use WebCodecs: it needs a separate MP4 demuxer, and
 * iOS Safari's implementation is inconsistent across the container/codec
 * combinations the Photos app produces. Setting `currentTime` and waiting for
 * `seeked` is deterministic, needs no user gesture, and works on every browser
 * that can play the file at all — which is the same bar the app already sets.
 */
export class VideoFrameReader {
  readonly element: HTMLVideoElement;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  private readonly objectUrl: string;
  private disposed = false;

  private constructor(
    element: HTMLVideoElement,
    objectUrl: string,
    width: number,
    height: number,
    duration: number,
  ) {
    this.element = element;
    this.objectUrl = objectUrl;
    this.width = width;
    this.height = height;
    this.duration = duration;
  }

  static async open(file: File): Promise<VideoFrameReader> {
    if (file.size === 0) throw new MediaError(`“${file.name}” is empty.`);

    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.crossOrigin = 'anonymous';
    // Keep it in the document but invisible: detached <video> elements can stall
    // in Safari, and `display:none` stops some builds from decoding at all.
    video.style.cssText =
      'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new MediaError(
            `“${file.name}” took too long to open.`,
            'The format may not be supported by this browser.',
          )),
          30_000,
        );
        const done = () => {
          window.clearTimeout(timer);
          video.removeEventListener('loadedmetadata', onMeta);
          video.removeEventListener('error', onError);
        };
        const onMeta = () => {
          done();
          resolve();
        };
        const onError = () => {
          done();
          reject(
            new MediaError(
              `“${file.name}” could not be played.`,
              'iPhone videos are usually .mov/.mp4 (H.264 or HEVC). Some formats — including AV1 and certain HEVC profiles — are not decodable in every browser.',
            ),
          );
        };
        video.addEventListener('loadedmetadata', onMeta);
        video.addEventListener('error', onError);
        video.src = url;
        video.load();
      });

      const width = video.videoWidth;
      const height = video.videoHeight;
      const duration = video.duration;

      if (!width || !height) {
        throw new MediaError(
          `“${file.name}” has no video track.`,
          'Audio-only files cannot be turned into a GIF.',
        );
      }
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new MediaError(
          `“${file.name}” has no usable duration.`,
          'Live Photos and streaming formats sometimes report no length. Try exporting the clip from Photos first.',
        );
      }
      if (duration > MAX_VIDEO_SECONDS) {
        throw new MediaError(
          `“${file.name}” is ${Math.round(duration / 60)} minutes long.`,
          `Please trim it to under ${MAX_VIDEO_SECONDS / 60} minutes before importing.`,
        );
      }

      // Nudging the pipeline once makes the first real seek far more reliable in
      // Safari; a muted, inline video is allowed to autoplay so no gesture is needed.
      try {
        await video.play();
        video.pause();
      } catch {
        // Autoplay refusal is harmless here — seeking still works.
      }
      video.currentTime = 0;

      return new VideoFrameReader(video, url, width, height, duration);
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /** Seeks and resolves once a frame for that timestamp is actually painted. */
  async seek(time: number): Promise<void> {
    if (this.disposed) throw new MediaError('This video has already been closed.');
    const video = this.element;
    // Stay a hair inside the duration: seeking to exactly `duration` can leave
    // some decoders showing the previous frame or nothing at all.
    const target = Math.min(Math.max(0, time), Math.max(0, this.duration - 0.001));

    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 1e-4) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let framePending = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(hardTimer);
        window.clearTimeout(paintTimer);
        if (framePending && hasFrameCallback(video)) video.cancelVideoFrameCallback(framePending);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        resolve();
      };

      const onSeeked = () => {
        // `seeked` can fire a beat before the new frame is composited. When
        // rVFC is available it tells us precisely; otherwise a short grace
        // period is enough in practice.
        if (hasFrameCallback(video)) {
          framePending = video.requestVideoFrameCallback(() => finish());
          paintTimer = window.setTimeout(finish, 150);
        } else {
          paintTimer = window.setTimeout(finish, 40);
        }
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(hardTimer);
        window.clearTimeout(paintTimer);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        reject(new MediaError('The video stopped decoding partway through.', 'The file may be damaged.'));
      };

      let paintTimer = 0;
      // A seek that never completes must not hang the export forever.
      const hardTimer = window.setTimeout(finish, 8000);

      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      try {
        video.currentTime = target;
      } catch (error) {
        onError();
        void error;
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.pause();
    this.element.removeAttribute('src');
    this.element.load();
    this.element.remove();
    URL.revokeObjectURL(this.objectUrl);
  }
}
