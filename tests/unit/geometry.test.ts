import { describe, expect, it } from 'vitest';
import {
  FULL_CROP,
  computePlacement,
  containRect,
  normaliseCrop,
  sanitiseDimension,
} from '../../src/render/geometry';

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
});

describe('dimension sanitising', () => {
  it('clamps to a usable range and rejects nonsense', () => {
    expect(sanitiseDimension(0)).toBe(16);
    expect(sanitiseDimension(99999)).toBe(2048);
    expect(sanitiseDimension(Number.NaN)).toBe(16);
    expect(sanitiseDimension(321.6)).toBe(322);
  });
});
