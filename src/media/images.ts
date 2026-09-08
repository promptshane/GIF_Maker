import { MediaError } from './errors';

/**
 * Longest edge kept for an imported photo. iPhone photos are ~12MP, which is
 * ~48MB per decoded bitmap; a dozen of those will crash mobile Safari. GIF
 * output never exceeds ~1024px, so 2048 keeps ample headroom for cropping.
 */
export const MAX_PHOTO_EDGE = 2048;
export const THUMB_EDGE = 200;

const looksHeic = (file: File): boolean =>
  /hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);

function drawToCanvas(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxEdge: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new MediaError('This browser cannot use a 2D canvas.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, width, height);
  return canvas;
}

/**
 * Decodes via `HTMLImageElement` rather than `createImageBitmap`.
 *
 * This is deliberate: an <img> applies EXIF orientation (iPhone photos are
 * almost always rotated via EXIF), and on iOS/macOS Safari it decodes HEIC
 * natively, which lets us skip the 3MB wasm converter entirely on the platform
 * this app targets.
 */
function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode-failed'));
    img.src = url;
  });
}

async function decodeWithHeicFallback(file: File): Promise<HTMLImageElement | ImageBitmap> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    if (img.naturalWidth > 0) return img;
    throw new Error('decode-failed');
  } catch (nativeError) {
    if (!looksHeic(file)) throw nativeError;
    // Safari decodes HEIC natively; other browsers need libheif, which we only
    // download when we actually hit a HEIC file the browser refused.
    try {
      const { heicTo } = await import('heic-to');
      return await heicTo({ blob: file, type: 'bitmap' });
    } catch {
      throw new MediaError(
        `“${file.name}” is a HEIC photo this browser cannot open.`,
        'Re-save it as JPEG, or set iPhone Settings › Camera › Formats to “Most Compatible”.',
      );
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface DecodedPhoto {
  image: ImageBitmap;
  width: number;
  height: number;
  thumbUrl: string;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new MediaError('Could not create a thumbnail.'))),
      type,
      quality,
    );
  });
}

/** Decodes one image file into a size-capped bitmap plus a film-strip thumbnail. */
export async function decodePhotoFile(file: File): Promise<DecodedPhoto> {
  if (file.size === 0) throw new MediaError(`“${file.name}” is empty.`);

  let source: HTMLImageElement | ImageBitmap;
  try {
    source = await decodeWithHeicFallback(file);
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(
      `“${file.name}” could not be opened.`,
      'It may be a format this browser does not support, or the file may be damaged.',
    );
  }

  const srcW = source instanceof ImageBitmap ? source.width : source.naturalWidth;
  const srcH = source instanceof ImageBitmap ? source.height : source.naturalHeight;
  if (!srcW || !srcH) {
    throw new MediaError(`“${file.name}” has no image data.`, 'The file may be damaged.');
  }

  try {
    const full = drawToCanvas(source, srcW, srcH, MAX_PHOTO_EDGE);
    const image = await createImageBitmap(full);
    const thumb = drawToCanvas(full, full.width, full.height, THUMB_EDGE);
    const thumbBlob = await canvasToBlob(thumb, 'image/jpeg', 0.8);
    // Release the intermediate canvases promptly; Safari is slow to GC them.
    full.width = full.height = 1;
    thumb.width = thumb.height = 1;
    return {
      image,
      width: image.width,
      height: image.height,
      thumbUrl: URL.createObjectURL(thumbBlob),
    };
  } finally {
    if (source instanceof ImageBitmap) source.close();
  }
}
