import { describe, expect, it } from 'vitest';
import { getPhotoExportProfile } from '../../src/export/photo';

describe('photo export quality', () => {
  it('keeps the current canvas dimensions at maximum quality', () => {
    const profile = getPhotoExportProfile(100, 1600, 1200);
    expect(profile.width).toBe(1600);
    expect(profile.height).toBe(1200);
    expect(profile.jpegQuality).toBeCloseTo(0.98);
  });

  it('reduces resolution and compression quality monotonically', () => {
    const low = getPhotoExportProfile(10, 1000, 800);
    const medium = getPhotoExportProfile(50, 1000, 800);
    const high = getPhotoExportProfile(90, 1000, 800);
    expect(low.width).toBeLessThan(medium.width);
    expect(medium.width).toBeLessThan(high.width);
    expect(low.jpegQuality).toBeLessThan(medium.jpegQuality);
    expect(medium.jpegQuality).toBeLessThan(high.jpegQuality);
  });

  it('clamps out-of-range quality values', () => {
    expect(getPhotoExportProfile(-50, 100, 100)).toEqual(
      getPhotoExportProfile(1, 100, 100),
    );
    expect(getPhotoExportProfile(500, 100, 100)).toEqual(
      getPhotoExportProfile(100, 100, 100),
    );
  });
});
