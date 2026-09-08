declare module 'gifenc' {
  export type RGB = [number, number, number];
  export type RGBA = [number, number, number, number];
  export type Palette = number[][];

  export interface WriteFrameOptions {
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    palette?: Palette | null;
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface GIFEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
    writeHeader(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: WriteFrameOptions,
    ): void;
  }

  export function GIFEncoder(opts?: { initialCapacity?: number; auto?: boolean }): GIFEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: {
      format?: 'rgb565' | 'rgb444' | 'rgba4444';
      clearAlpha?: boolean;
      clearAlphaColor?: number;
      clearAlphaThreshold?: number;
      oneBitAlpha?: boolean | number;
    },
  ): Palette;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;

  export function prequantize(
    rgba: Uint8Array | Uint8ClampedArray,
    opts?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number },
  ): void;

  export function nearestColorIndex(colors: Palette, pixel: number[]): number;
  const _default: typeof GIFEncoder;
  export default _default;
}
