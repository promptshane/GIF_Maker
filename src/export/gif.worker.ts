/// <reference lib="webworker" />
import { GifSession } from './gifCore';
import type { EncodeRequest, EncodeResponse } from './protocol';

let session: GifSession | null = null;

const post = (message: EncodeResponse, transfer: Transferable[] = []): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);
};

self.onmessage = (event: MessageEvent<EncodeRequest>) => {
  const message = event.data;
  try {
    if (message.type === 'begin') {
      session = new GifSession({
        width: message.width,
        height: message.height,
        profile: message.profile,
        totalFrames: message.totalFrames,
        paletteSamples: message.paletteSamples.length
          ? message.paletteSamples.map((buffer) => new Uint8ClampedArray(buffer))
          : undefined,
      });
      return;
    }

    if (message.type === 'frame') {
      if (!session) throw new Error('Encoder received a frame before it was started.');
      session.addFrame(new Uint8ClampedArray(message.buffer), message.delayMs);
      // The ack is what applies backpressure: the app will not render ahead of
      // the encoder by more than a couple of frames.
      post({ type: 'ack', index: message.index });
      return;
    }

    if (message.type === 'end') {
      if (!session) throw new Error('Encoder was finished before it was started.');
      const bytes = session.finish();
      const frames = session.written;
      const paletteSize = session.paletteSize;
      // Copy into a standalone buffer so it can be transferred cleanly.
      const out = new Uint8Array(bytes.length);
      out.set(bytes);
      session = null;
      post({ type: 'done', buffer: out.buffer, frames, paletteSize }, [out.buffer]);
    }
  } catch (error) {
    session = null;
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
