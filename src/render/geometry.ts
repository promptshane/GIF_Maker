import type { CropRect, FitMode } from '../state/types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

/**
 * Largest rectangle of the given aspect ratio that fits inside `w`x`h`, centred.
 * Used both for `fit` placement and for constraining the crop rectangle.
 */
export function containRect(srcW: number, srcH: number, w: number, h: number): Rect {
  const scale = Math.min(w / srcW, h / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
}

export interface DrawPlacement {
  /** Source rectangle in source pixels. */
  src: Rect;
  /** Destination rectangle in canvas pixels. */
  dst: Rect;
  /** True when the background is visible around the image. */
  letterboxed: boolean;
}

/**
 * Resolves how a source image/frame maps onto the output canvas.
 *
 * `crop` mode re-normalises the rectangle against the image actually being
 * drawn, so the blit onto the full canvas is always undistorted — even for a
 * photo whose aspect differs from the one the crop was framed on. For the
 * source the crop was normalised against this is a no-op.
 */
export function computePlacement(
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  fitMode: FitMode,
  crop: CropRect = FULL_CROP,
): DrawPlacement {
  if (fitMode === 'fit') {
    const dst = containRect(srcW, srcH, canvasW, canvasH);
    return {
      src: { x: 0, y: 0, w: srcW, h: srcH },
      dst,
      letterboxed: dst.w < canvasW - 0.5 || dst.h < canvasH - 0.5,
    };
  }

  if (fitMode === 'fill') {
    // Cover: pick the centred source sub-rect that has the canvas aspect ratio.
    const src = containRect(canvasW, canvasH, srcW, srcH);
    return { src, dst: { x: 0, y: 0, w: canvasW, h: canvasH }, letterboxed: false };
  }

  const safe = normaliseCrop(crop, srcW, srcH, canvasW, canvasH);
  const src: Rect = {
    x: safe.x * srcW,
    y: safe.y * srcH,
    w: safe.w * srcW,
    h: safe.h * srcH,
  };
  return { src, dst: { x: 0, y: 0, w: canvasW, h: canvasH }, letterboxed: false };
}

/** Smallest crop, as a fraction of the source width. */
export const MIN_CROP = 0.05;

/**
 * Ratio of normalised width to normalised height that gives a rectangle the
 * output's pixel aspect: (w·srcW)/(h·srcH) = canvasW/canvasH.
 */
const cropRatio = (srcW: number, srcH: number, canvasW: number, canvasH: number): number =>
  (canvasW / canvasH) / (srcW / srcH);

/**
 * Positions a w×h rectangle on the centre of `from`, inside the unit square.
 * A side that did not change keeps its origin exactly, so re-normalising an
 * already valid crop returns it byte-for-byte rather than a hair off.
 */
function placeCrop(from: CropRect, w: number, h: number): CropRect {
  const x = w === from.w ? from.x : from.x + from.w / 2 - w / 2;
  const y = h === from.h ? from.y : from.y + from.h / 2 - h / 2;
  return {
    x: clamp(x, 0, Math.max(0, 1 - w)),
    y: clamp(y, 0, Math.max(0, 1 - h)),
    w,
    h,
  };
}

/**
 * Forces a crop rectangle to the output aspect ratio and keeps it inside the
 * source, so `crop` mode never distorts the image or samples outside it.
 *
 * The result is centred on the centre of the rectangle you pass in — width is
 * authoritative and height is recomputed from it. Callers that resize a crop
 * must therefore pass the centre they want to keep, not just a new width.
 *
 * Use this for edits made *at* the current aspect. When the output aspect
 * itself changes, use `refitCrop` instead: taking width as authoritative there
 * can only ever shrink the crop, and repeated aspect changes would ratchet it
 * down to a tiny zoomed-in patch.
 */
export function normaliseCrop(
  crop: CropRect,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
): CropRect {
  const k = cropRatio(srcW, srcH, canvasW, canvasH);
  let w = clamp(crop.w, MIN_CROP, 1);
  let h = w / k;
  if (h > 1) {
    h = 1;
    w = h * k;
  }
  return placeCrop(crop, w, h);
}

/**
 * Re-fits a crop when the output aspect changes: the smallest rectangle of the
 * new aspect that still contains everything the old crop showed, centred on
 * the same point, then shrunk (aspect preserved) only if it overflows the
 * source. Going 16:9 → 1:1 → 16:9 therefore lands back exactly where it
 * started, instead of zooming in a little further every time.
 */
export function refitCrop(
  crop: CropRect,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
): CropRect {
  const k = cropRatio(srcW, srcH, canvasW, canvasH);
  let w = Math.max(MIN_CROP, crop.w, crop.h * k);
  let h = w / k;
  if (w > 1) {
    w = 1;
    h = w / k;
  }
  if (h > 1) {
    h = 1;
    w = h * k;
  }
  return placeCrop(crop, w, h);
}

/** Even dimensions keep encoders and scaling predictable; GIF requires >= 1px. */
export function sanitiseDimension(value: number, min = 16, max = 2048): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(clamp(Math.round(value), min, max));
}

/**
 * Output size when one side is typed and the aspect ratio is locked.
 *
 * The other side is derived from the *raw* value and the pair is scaled into
 * range together, so a value that hits the minimum or maximum cannot quietly
 * turn a 16:9 output into a square (16×9 would clamp to 16×16 otherwise).
 */
export function fitLockedDimensions(
  value: number,
  driver: 'width' | 'height',
  aspect: number,
  min = 16,
  max = 2048,
): { width: number; height: number } {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let width = driver === 'width' ? value : value * safeAspect;
  let height = driver === 'width' ? value / safeAspect : value;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    width = min * Math.max(1, safeAspect);
    height = min * Math.max(1, 1 / safeAspect);
  }
  // Scale the pair so the smaller side reaches `min` and the larger stays under `max`.
  const grow = min / Math.min(width, height);
  if (grow > 1) {
    width *= grow;
    height *= grow;
  }
  const shrink = max / Math.max(width, height);
  if (shrink < 1) {
    width *= shrink;
    height *= shrink;
  }
  return { width: sanitiseDimension(width, min, max), height: sanitiseDimension(height, min, max) };
}
