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
 * `crop` mode assumes the crop rectangle already matches the canvas aspect ratio
 * (`normaliseCrop` guarantees this), so the mapping is a straight, undistorted
 * blit from the crop rect to the full canvas.
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

  const src: Rect = {
    x: crop.x * srcW,
    y: crop.y * srcH,
    w: crop.w * srcW,
    h: crop.h * srcH,
  };
  return { src, dst: { x: 0, y: 0, w: canvasW, h: canvasH }, letterboxed: false };
}

/**
 * Forces a crop rectangle to the output aspect ratio and keeps it inside the
 * source, so `crop` mode never distorts the image or samples outside it.
 *
 * The result is centred on the centre of the rectangle you pass in — width is
 * authoritative and height is recomputed from it. Callers that resize a crop
 * must therefore pass the centre they want to keep, not just a new width.
 */
export function normaliseCrop(
  crop: CropRect,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
): CropRect {
  const targetAspect = canvasW / canvasH;
  const srcAspect = srcW / srcH;
  // Work in normalised units where the aspect correction factor is srcAspect.
  // A normalised rect (w, h) has pixel aspect (w*srcW)/(h*srcH).
  // Solve for h given w: h = w * srcAspect / targetAspect.
  let w = clamp(crop.w, 0.02, 1);
  let h = (w * srcAspect) / targetAspect;
  if (h > 1) {
    h = 1;
    w = (h * targetAspect) / srcAspect;
  }
  if (w > 1) {
    w = 1;
    h = (w * srcAspect) / targetAspect;
  }
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  const x = clamp(cx - w / 2, 0, Math.max(0, 1 - w));
  const y = clamp(cy - h / 2, 0, Math.max(0, 1 - h));
  return { x, y, w, h };
}

/** Even dimensions keep encoders and scaling predictable; GIF requires >= 1px. */
export function sanitiseDimension(value: number, min = 16, max = 2048): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(clamp(Math.round(value), min, max));
}
