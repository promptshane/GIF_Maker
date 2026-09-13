import { describe, expect, it } from 'vitest';
import { blurRadius, pixelBlockSize } from '../../src/render/compose';

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
