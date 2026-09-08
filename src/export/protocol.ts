import type { QualityProfile } from './quality';

/** Messages sent from the app to the encoding worker. */
export type EncodeRequest =
  | {
      type: 'begin';
      width: number;
      height: number;
      profile: QualityProfile;
      totalFrames: number;
      /** RGBA buffers used to derive the shared palette. Transferred. */
      paletteSamples: ArrayBuffer[];
    }
  | { type: 'frame'; index: number; delayMs: number; buffer: ArrayBuffer }
  | { type: 'end' };

/** Messages sent from the encoding worker back to the app. */
export type EncodeResponse =
  | { type: 'ack'; index: number }
  | { type: 'done'; buffer: ArrayBuffer; frames: number; paletteSize: number }
  | { type: 'error'; message: string };
