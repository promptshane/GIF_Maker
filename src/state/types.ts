/** Domain model for the whole editor. Kept free of React so it can be unit tested. */

export type SourceKind = 'photos' | 'video';
export type ProjectMode = 'gif' | 'photo';

export interface PhotoAsset {
  id: string;
  name: string;
  width: number;
  height: number;
  /** How long this photo is shown in the GIF, in milliseconds. */
  durationMs: number;
  /** Decoded bitmap, owned by the store and closed when the photo is removed. */
  image: ImageBitmap;
  /** Small object URL used by the film strip. Revoked with the photo. */
  thumbUrl: string;
  /**
   * The file as picked, kept so the project can be saved and reopened. A
   * duplicate shares its original's file, bitmap and thumbnail.
   */
  file: Blob;
}

export interface VideoAsset {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Intrinsic duration in seconds. */
  duration: number;
  type: string;
  sizeBytes: number;
  /** The file as picked, kept so the project can be saved and reopened. */
  file: Blob;
}

// ------------------------------------------------------------------ canvas

export type CanvasPreset = 'original' | 'square' | 'portrait' | 'landscape' | 'custom';

/**
 * How the source is placed inside the output canvas.
 * - `fit`  letterbox the whole source (background shows through)
 * - `fill` scale to cover and centre-crop automatically
 * - `crop` use the user-positioned crop rectangle (constrained to the output aspect)
 */
export type FitMode = 'fit' | 'fill' | 'crop';

export interface CanvasSettings {
  preset: CanvasPreset;
  width: number;
  height: number;
  lockAspect: boolean;
  fitMode: FitMode;
  background: string;
}

/** Normalised rectangle (0..1) in *source* space, used by `crop` fit mode. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------- playback

export type Direction = 'forward' | 'reverse' | 'boomerang';

export interface VideoSettings {
  /** Trim window in seconds on the source timeline. */
  trimStart: number;
  trimEnd: number;
  direction: Direction;
  /** Playback rate multiplier: >1 is faster (shorter GIF). */
  speed: number;
}

// ---------------------------------------------------------------- overlays

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface Sticker {
  id: string;
  emoji: string;
  /** Centre point, normalised to the output canvas. */
  x: number;
  y: number;
  /** Glyph size as a fraction of the canvas's shorter side. */
  size: number;
  /** Rotation in radians. */
  rotation: number;
  /** `null` means visible for the entire GIF. */
  range: TimeRange | null;
}

export type CensorShape = 'rect' | 'circle';
export type CensorEffect = 'blur' | 'pixelate' | 'black';

/**
 * A censor position at a point in time. Regions always hold at least one
 * keyframe; two or more make the region follow a moving subject, with the
 * rectangle linearly interpolated between them.
 */
export interface CensorKeyframe {
  /** Time on the output timeline, in milliseconds. */
  t: number;
  /** Centre + size, normalised to the output canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CensorRegion {
  id: string;
  shape: CensorShape;
  effect: CensorEffect;
  /** 0..1, mapped to a pixel radius / block size at render time. */
  strength: number;
  range: TimeRange | null;
  /** Sorted by `t`, never empty. */
  keyframes: CensorKeyframe[];
}

// ------------------------------------------------------------------ export

export type QualityLevel = 'low' | 'medium' | 'high' | 'extra';

export interface ExportResult {
  blob: Blob;
  url: string;
  bytes: number;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
  quality: QualityLevel;
}

export interface SizeEstimate {
  /** Bytes, low and high end of the extrapolation. */
  lowBytes: number;
  highBytes: number;
  sampledFrames: number;
  totalFrames: number;
}
