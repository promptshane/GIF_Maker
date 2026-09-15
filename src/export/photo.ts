import type { FrameProvider } from '../media/frames';
import type { FrameSource } from '../render/timeline';
import { clamp } from '../render/geometry';
import { FrameRenderer, type RenderSettings } from './renderPipeline';

export interface PhotoExportProfile {
  width: number;
  height: number;
  jpegQuality: number;
}

/**
 * Maps the friendly 1–100 slider to both pixel count and JPEG compression.
 * At 100 the current canvas dimensions are preserved. At the low end the
 * image is intentionally small and visibly compressed.
 */
export function getPhotoExportProfile(
  quality: number,
  width: number,
  height: number,
): PhotoExportProfile {
  const t = clamp(quality, 1, 100) / 100;
  const scale = 0.22 + 0.78 * t;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    jpegQuality: 0.16 + 0.82 * t,
  };
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The edited photo could not be encoded.'))),
      'image/jpeg',
      quality,
    );
  });
}

/** Render and encode one still image. The preview and download both use this blob. */
export async function renderPhotoBlob(
  provider: FrameProvider,
  source: FrameSource,
  settings: RenderSettings,
  quality: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const profile = getPhotoExportProfile(quality, settings.width, settings.height);
  const renderer = new FrameRenderer(profile.width, profile.height);
  try {
    const pixels = await renderer.render(provider, source, 0, settings);
    const canvas = document.createElement('canvas');
    canvas.width = profile.width;
    canvas.height = profile.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser cannot render an edited photo.');
    ctx.putImageData(pixels, 0, 0);
    return {
      blob: await toJpeg(canvas, profile.jpegQuality),
      width: profile.width,
      height: profile.height,
    };
  } finally {
    renderer.dispose();
  }
}
