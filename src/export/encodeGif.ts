import type { FramePlan } from '../render/timeline';
import type { FrameProvider } from '../media/frames';
import type { QualityProfile } from './quality';
import type { EncodeRequest, EncodeResponse } from './protocol';
import { FrameRenderer, type RenderSettings } from './renderPipeline';
import { GifSession } from './gifCore';
import { MediaError } from '../media/errors';

export type EncodePhase = 'preparing' | 'rendering' | 'finishing';

export interface EncodeProgress {
  phase: EncodePhase;
  done: number;
  total: number;
}

export interface EncodeOptions {
  plan: FramePlan;
  provider: FrameProvider;
  settings: RenderSettings;
  profile: QualityProfile;
  paletteSamples: Uint8ClampedArray[];
  signal?: AbortSignal;
  onProgress?: (progress: EncodeProgress) => void;
}

export interface EncodeOutput {
  bytes: Uint8Array;
  frames: number;
  paletteSize: number;
}

/**
 * Abstracts "somewhere that can encode GIF frames". A dedicated worker keeps the
 * palette mapping and LZW compression off the main thread so the UI keeps
 * responding; the in-process backend is the fallback for environments where
 * module workers are unavailable or blocked.
 */
interface EncoderBackend {
  begin(
    width: number,
    height: number,
    profile: QualityProfile,
    totalFrames: number,
    paletteSamples: Uint8ClampedArray[],
  ): void;
  addFrame(index: number, delayMs: number, data: Uint8ClampedArray): Promise<void>;
  end(): Promise<EncodeOutput>;
  destroy(): void;
}

class WorkerBackend implements EncoderBackend {
  private readonly worker: Worker;
  private readonly pending = new Map<number, () => void>();
  private finishResolve: ((output: EncodeOutput) => void) | null = null;
  private failure: ((error: Error) => void) | null = null;
  private error: Error | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<EncodeResponse>) => {
      const message = event.data;
      if (message.type === 'ack') {
        this.pending.get(message.index)?.();
        this.pending.delete(message.index);
      } else if (message.type === 'done') {
        this.finishResolve?.({
          bytes: new Uint8Array(message.buffer),
          frames: message.frames,
          paletteSize: message.paletteSize,
        });
      } else {
        this.fail(new MediaError(message.message));
      }
    };
    this.worker.onerror = (event) => {
      this.fail(new MediaError(event.message || 'The GIF encoder stopped unexpectedly.'));
    };
  }

  private fail(error: Error): void {
    this.error = error;
    for (const resolve of this.pending.values()) resolve();
    this.pending.clear();
    this.failure?.(error);
  }

  private send(message: EncodeRequest, transfer: Transferable[] = []): void {
    if (this.error) throw this.error;
    this.worker.postMessage(message, transfer);
  }

  begin(
    width: number,
    height: number,
    profile: QualityProfile,
    totalFrames: number,
    paletteSamples: Uint8ClampedArray[],
  ): void {
    // Copied rather than transferred: these buffers are small (a few hundred KB
    // total) and the caller reuses them across estimate/export runs, so
    // detaching them would silently empty the palette on the second call.
    const buffers = paletteSamples.map((sample) => sample.slice().buffer as ArrayBuffer);
    this.send({ type: 'begin', width, height, profile, totalFrames, paletteSamples: buffers });
  }

  addFrame(index: number, delayMs: number, data: Uint8ClampedArray): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    const buffer = data.buffer as ArrayBuffer;
    return new Promise<void>((resolve, reject) => {
      this.failure = reject;
      this.pending.set(index, resolve);
      try {
        this.send({ type: 'frame', index, delayMs, buffer }, [buffer]);
      } catch (error) {
        this.pending.delete(index);
        reject(error as Error);
      }
    });
  }

  end(): Promise<EncodeOutput> {
    if (this.error) return Promise.reject(this.error);
    return new Promise<EncodeOutput>((resolve, reject) => {
      this.finishResolve = resolve;
      this.failure = reject;
      try {
        this.send({ type: 'end' });
      } catch (error) {
        reject(error as Error);
      }
    });
  }

  destroy(): void {
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }
}

class InlineBackend implements EncoderBackend {
  private session: GifSession | null = null;

  begin(
    width: number,
    height: number,
    profile: QualityProfile,
    totalFrames: number,
    paletteSamples: Uint8ClampedArray[],
  ): void {
    this.session = new GifSession({
      width,
      height,
      profile,
      totalFrames,
      paletteSamples: paletteSamples.length ? paletteSamples : undefined,
    });
  }

  async addFrame(_index: number, delayMs: number, data: Uint8ClampedArray): Promise<void> {
    if (!this.session) throw new MediaError('Encoder was not started.');
    this.session.addFrame(data, delayMs);
    // Hand the main thread back to the browser so the progress UI can paint.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async end(): Promise<EncodeOutput> {
    if (!this.session) throw new MediaError('Encoder was not started.');
    const bytes = this.session.finish();
    const output = {
      bytes,
      frames: this.session.written,
      paletteSize: this.session.paletteSize,
    };
    this.session = null;
    return output;
  }

  destroy(): void {
    this.session = null;
  }
}

function createBackend(): EncoderBackend {
  try {
    const worker = new Worker(new URL('./gif.worker.ts', import.meta.url), {
      type: 'module',
      name: 'gif-encoder',
    });
    return new WorkerBackend(worker);
  } catch {
    // Some privacy modes and embedded webviews block workers entirely.
    return new InlineBackend();
  }
}

/** How many frames may be in flight before we wait for the encoder to catch up. */
const PIPELINE_DEPTH = 2;

/**
 * Renders and encodes a full GIF.
 *
 * Frames are produced one at a time and handed straight to the encoder, so peak
 * memory is a few frames rather than the whole animation — which is what makes
 * long clips survivable on an iPhone.
 */
export async function encodeGif(options: EncodeOptions): Promise<EncodeOutput> {
  const { plan, provider, settings, profile, paletteSamples, signal, onProgress } = options;
  if (plan.frames.length === 0) {
    throw new MediaError('There are no frames to export.', 'Import a photo or a video first.');
  }

  const renderer = new FrameRenderer(settings.width, settings.height);
  const backend = createBackend();
  const inFlight: Array<Promise<void>> = [];

  const abortCheck = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };

  try {
    onProgress?.({ phase: 'preparing', done: 0, total: plan.frames.length });
    abortCheck();
    backend.begin(renderer.width, renderer.height, profile, plan.frames.length, paletteSamples);

    for (let i = 0; i < plan.frames.length; i++) {
      abortCheck();
      const frame = plan.frames[i];
      const imageData = await renderer.render(provider, frame.source, frame.timeMs, settings);

      const sent = backend.addFrame(i, frame.delayMs, imageData.data);
      inFlight.push(sent);
      if (inFlight.length >= PIPELINE_DEPTH) {
        await inFlight.shift();
      }
      onProgress?.({ phase: 'rendering', done: i + 1, total: plan.frames.length });
    }

    await Promise.all(inFlight);
    abortCheck();
    onProgress?.({ phase: 'finishing', done: plan.frames.length, total: plan.frames.length });
    return await backend.end();
  } finally {
    // Swallow rejections from frames abandoned by an abort.
    for (const promise of inFlight) promise.catch(() => undefined);
    renderer.dispose();
    backend.destroy();
  }
}

export interface EstimateOptions extends Omit<EncodeOptions, 'onProgress'> {
  /** Contiguous frames to actually encode before extrapolating. */
  sampleFrames?: number;
}

export interface SizeEstimate {
  lowBytes: number;
  highBytes: number;
  sampledFrames: number;
  totalFrames: number;
}

/**
 * Estimates the finished size by genuinely encoding a short contiguous run of
 * frames with the exact settings that will be used, then extrapolating.
 *
 * A contiguous run matters: after the first frame, each frame only stores what
 * changed, so encoding scattered frames independently would badly over-count.
 * The result is reported as a range because content later in the clip may
 * compress differently.
 */
export async function estimateGifSize(options: EstimateOptions): Promise<SizeEstimate | null> {
  const { plan, provider, settings, profile, paletteSamples, signal } = options;
  const total = plan.frames.length;
  if (total === 0) return null;

  const sampleFrames = Math.min(options.sampleFrames ?? 7, total);
  // Two frames minimum, otherwise there is no delta to measure at all.
  if (sampleFrames < 2) return null;

  // Start a quarter of the way in: opening frames are often atypical
  // (fade-ins, a title card, a static first photo).
  const start = Math.min(total - sampleFrames, Math.floor(total * 0.25));

  const renderer = new FrameRenderer(settings.width, settings.height);
  const session = new GifSession({
    width: renderer.width,
    height: renderer.height,
    profile,
    totalFrames: sampleFrames,
    paletteSamples: paletteSamples.length ? paletteSamples : undefined,
  });

  try {
    let firstData: ImageData | null = null;
    for (let i = 0; i < sampleFrames; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const frame = plan.frames[start + i];
      const data = await renderer.render(provider, frame.source, frame.timeMs, settings);
      if (i === 0) firstData = data;
      session.addFrame(data.data, frame.delayMs);
      // Yield so a long estimate cannot lock up the UI.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const bytes = session.finish();

    // Encode the first sampled frame on its own to separate the one-off
    // keyframe cost from the per-frame delta cost.
    const solo = new GifSession({
      width: renderer.width,
      height: renderer.height,
      profile,
      totalFrames: 1,
      paletteSamples: paletteSamples.length ? paletteSamples : undefined,
    });
    solo.addFrame(firstData!.data, plan.frames[start].delayMs);
    const firstBytes = solo.finish().length;

    const deltaBytes = Math.max(0, bytes.length - firstBytes);
    const perFrame = deltaBytes / Math.max(1, sampleFrames - 1);
    const expected = firstBytes + perFrame * Math.max(0, total - 1);

    return {
      lowBytes: Math.round(expected * 0.75),
      highBytes: Math.round(expected * 1.35),
      sampledFrames: sampleFrames,
      totalFrames: total,
    };
  } finally {
    renderer.dispose();
  }
}
