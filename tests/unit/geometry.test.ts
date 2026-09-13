import { describe, expect, it } from 'vitest';
import {
  FULL_CROP,
  computePlacement,
  containRect,
  fitLockedDimensions,
  normaliseCrop,
  refitCrop,
  sanitiseDimension,
} from '../../src/render/geometry';

/** Pixel aspect of a normalised crop on a given source. */
const pixelAspect = (crop: { w: number; h: number }, srcW: number, srcH: number) =>
  (crop.w * srcW) / (crop.h * srcH);

describe('placement', () => {
  it('fit letterboxes a wide source into a square canvas', () => {
    const { src, dst, letterboxed } = computePlacement(640, 360, 480, 480, 'fit');
    expect(src).toEqual({ x: 0, y: 0, w: 640, h: 360 });
    expect(dst.w).toBe(480);
    expect(dst.h).toBe(270);
    expect(dst.y).toBe(105);
    expect(letterboxed).toBe(true);
  });

  it('fill centre-crops the source so nothing is letterboxed', () => {
    const { src, dst, letterboxed } = computePlacement(640, 360, 480, 480, 'fill');
    expect(dst).toEqual({ x: 0, y: 0, w: 480, h: 480 });
    expect(letterboxed).toBe(false);
    // The kept region is as tall as the source and square.
    expect(src.h).toBe(360);
    expect(src.w).toBe(360);
    expect(src.x).toBe(140);
  });

  it('crop maps the chosen rectangle onto the whole canvas', () => {
    const crop = { x: 0.25, y: 0.1, w: 0.5, h: 0.5 };
    const { src, dst } = computePlacement(600, 400, 300, 200, 'crop', crop);
    expect(src).toEqual({ x: 150, y: 40, w: 300, h: 200 });
    expect(dst).toEqual({ x: 0, y: 0, w: 300, h: 200 });
  });

  it('contain fills exactly when the aspects already match', () => {
    expect(containRect(100, 50, 200, 100)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });

  it('never stretches a photo whose aspect differs from the one the crop was framed on', () => {
    // Crop framed on a 16:9 photo, square output.
    const crop = normaliseCrop({ x: 0.2, y: 0.1, w: 0.5, h: 0.5 }, 1600, 900, 480, 480);
    // The same crop applied to a portrait photo in the same project.
    const { src, dst } = computePlacement(900, 1600, 480, 480, 'crop', crop);
    expect(src.w / src.h).toBeCloseTo(dst.w / dst.h, 6);
    expect(src.x).toBeGreaterThanOrEqual(0);
    expect(src.y).toBeGreaterThanOrEqual(0);
    expect(src.x + src.w).toBeLessThanOrEqual(900 + 1e-6);
    expect(src.y + src.h).toBeLessThanOrEqual(1600 + 1e-6);
  });
});

describe('crop normalisation', () => {
  it('forces the crop to the output aspect so nothing is stretched', () => {
    // 640x360 source, square output: the crop must be square in pixels.
    const crop = normaliseCrop({ x: 0, y: 0, w: 1, h: 1 }, 640, 360, 480, 480);
    expect((crop.w * 640) / (crop.h * 360)).toBeCloseTo(1, 5);
    expect(crop.h).toBeCloseTo(1, 5);
    expect(crop.w).toBeCloseTo(360 / 640, 5);
  });

  it('keeps the crop inside the source', () => {
    const crop = normaliseCrop({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 800, 800, 100, 100);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.w).toBeLessThanOrEqual(1.0001);
    expect(crop.y + crop.h).toBeLessThanOrEqual(1.0001);
  });

  it('centres the result on the centre of the rectangle it is given', () => {
    const before = normaliseCrop({ x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, 500, 500, 100, 100);
    const centreX = before.x + before.w / 2;
    const centreY = before.y + before.h / 2;
    // Resizing means passing the centre you want to keep, which is what the
    // crop editor does.
    const after = normaliseCrop(
      { x: centreX - 0.15, y: centreY - before.h / 2, w: 0.3, h: before.h },
      500, 500, 100, 100,
    );
    expect(after.w).toBeCloseTo(0.3, 5);
    expect(after.x + after.w / 2).toBeCloseTo(centreX, 5);
    expect(after.y + after.h / 2).toBeCloseTo(centreY, 5);
  });

  it('never produces a degenerate rectangle', () => {
    const crop = normaliseCrop({ x: 0, y: 0, w: 0, h: 0 }, 640, 480, 480, 640);
    expect(crop.w).toBeGreaterThan(0);
    expect(crop.h).toBeGreaterThan(0);
  });

  it('leaves a full crop untouched when the aspects already match', () => {
    expect(normaliseCrop(FULL_CROP, 640, 480, 320, 240)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('is idempotent, so re-normalising on every frame cannot drift', () => {
    const once = normaliseCrop({ x: 0.13, y: 0.27, w: 0.41, h: 0.6 }, 1920, 1080, 720, 405);
    expect(normaliseCrop(once, 1920, 1080, 720, 405)).toEqual(once);
  });
});

describe('crop refit on aspect change', () => {
  it('returns to the full frame after a round trip through other aspects', () => {
    // This is the sequence that used to zoom in a little further on every
    // change and never recover.
    let crop = { ...FULL_CROP };
    const outputs: Array<[number, number]> = [
      [576, 720], // 4:5
      [720, 405], // 16:9
      [720, 720], // 1:1
      [720, 405], // 16:9
    ];
    for (const [w, h] of outputs) {
      crop = refitCrop(crop, 1920, 1080, w, h);
      expect(pixelAspect(crop, 1920, 1080)).toBeCloseTo(w / h, 6);
    }
    expect(crop.w).toBeCloseTo(1, 6);
    expect(crop.h).toBeCloseTo(1, 6);
  });

  it('keeps everything the old crop showed, centred on the same point', () => {
    const before = normaliseCrop({ x: 0.3, y: 0.3, w: 0.3, h: 0.3 }, 1000, 1000, 400, 400);
    const after = refitCrop(before, 1000, 1000, 800, 450);
    expect(pixelAspect(after, 1000, 1000)).toBeCloseTo(800 / 450, 6);
    expect(after.x).toBeLessThanOrEqual(before.x + 1e-9);
    expect(after.y).toBeLessThanOrEqual(before.y + 1e-9);
    expect(after.x + after.w).toBeGreaterThanOrEqual(before.x + before.w - 1e-9);
    expect(after.y + after.h).toBeGreaterThanOrEqual(before.y + before.h - 1e-9);
    expect(after.x + after.w / 2).toBeCloseTo(before.x + before.w / 2, 6);
    expect(after.y + after.h / 2).toBeCloseTo(before.y + before.h / 2, 6);
  });

  it('shrinks only when the covering rectangle would leave the source', () => {
    const wide = refitCrop({ x: 0, y: 0, w: 1, h: 1 }, 1000, 1000, 2000, 500);
    expect(wide).toEqual({ x: 0, y: 0.375, w: 1, h: 0.25 });
  });
});

describe('dimension sanitising', () => {
  it('clamps to a usable range and rejects nonsense', () => {
    expect(sanitiseDimension(0)).toBe(16);
    expect(sanitiseDimension(99999)).toBe(2048);
    expect(sanitiseDimension(Number.NaN)).toBe(16);
    expect(sanitiseDimension(321.6)).toBe(322);
  });

  it('keeps a locked aspect when a typed value hits the minimum or maximum', () => {
    const aspect = 16 / 9;
    // "7" on the way to "720" used to clamp both sides to 16 and make it square.
    const tiny = fitLockedDimensions(7, 'width', aspect);
    expect(tiny.height).toBe(16);
    expect(tiny.width / tiny.height).toBeCloseTo(aspect, 1);

    const huge = fitLockedDimensions(9000, 'width', aspect);
    expect(huge.width).toBe(2048);
    expect(huge.width / huge.height).toBeCloseTo(aspect, 2);

    const byHeight = fitLockedDimensions(405, 'height', aspect);
    expect(byHeight).toEqual({ width: 720, height: 405 });
  });

  it('falls back to a sane size for garbage input', () => {
    const result = fitLockedDimensions(Number.NaN, 'width', 1);
    expect(result.width).toBeGreaterThanOrEqual(16);
    expect(result.height).toBeGreaterThanOrEqual(16);
  });
});
