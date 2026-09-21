import { describe, expect, it } from 'vitest';
import { blurRadius, censorPixelGeometry, pixelBlockSize } from '../../src/render/compose';

// Both maps take only the strength and the canvas's short side — the region's
// own size is deliberately not an input, so a bigger region gets the same blur
// radius and the same block size as a small one.
describe('censor strength', () => {
  it('grows monotonically with strength', () => {
    let lastBlur = 0;
    let lastBlock = 0;
    for (let s = 0; s <= 1.0001; s += 0.1) {
      const blur = blurRadius(s, 480);
      const block = pixelBlockSize(s, 480);
      expect(blur).toBeGreaterThanOrEqual(lastBlur);
      expect(block).toBeGreaterThanOrEqual(lastBlock);
      lastBlur = blur;
      lastBlock = block;
    }
    expect(blurRadius(1, 480)).toBeGreaterThan(blurRadius(0, 480) * 4);
    expect(pixelBlockSize(1, 480)).toBeGreaterThan(pixelBlockSize(0, 480) * 4);
  });

  it('scales with output resolution so preview and export match', () => {
    expect(blurRadius(0.5, 960) / blurRadius(0.5, 480)).toBeCloseTo(2, 0);
    expect(pixelBlockSize(0.5, 960) / pixelBlockSize(0.5, 480)).toBeCloseTo(2, 1);
  });

  it('never collapses to nothing', () => {
    expect(blurRadius(0, 16)).toBeGreaterThanOrEqual(1);
    expect(pixelBlockSize(0, 16)).toBeGreaterThanOrEqual(1);
  });
});


describe('censor animated size geometry', () => {
  it('keeps fractional visible bounds instead of rounding size to whole pixels', () => {
    const a = censorPixelGeometry({ x: 0.5, y: 0.5, w: 0.333, h: 0.271 }, 480, 360);
    const b = censorPixelGeometry({ x: 0.5, y: 0.5, w: 0.334, h: 0.272 }, 480, 360);

    expect(a.w).toBeCloseTo(159.84, 6);
    expect(b.w).toBeCloseTo(160.32, 6);
    expect(b.w - a.w).toBeCloseTo(0.48, 6);
    expect(b.clipW).toBeGreaterThan(a.clipW);
    expect(b.clipH).toBeGreaterThan(a.clipH);

    // Whole-pixel sampling still fully covers the fractional visible clip.
    expect(a.sampleX).toBeLessThanOrEqual(a.left);
    expect(a.sampleX + a.sampleW).toBeGreaterThanOrEqual(a.left + a.clipW);
  });
});
