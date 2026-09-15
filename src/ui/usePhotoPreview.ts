import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FrameProvider } from '../media/frames';
import type { FrameSource } from '../render/timeline';
import type { RenderSettings } from '../export/renderPipeline';
import { renderPhotoBlob } from '../export/photo';

const PREVIEW_MAX_EDGE = 640;

export interface PhotoPreviewResult {
  blob: Blob;
  url: string;
  bytes: number;
  width: number;
  height: number;
}

/** Builds the real JPEG and paints that decoded file into the editor canvas. */
export function usePhotoPreview(
  provider: FrameProvider | null,
  source: FrameSource | null,
  settings: RenderSettings,
  quality: number,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [result, setResult] = useState<PhotoPreviewResult | null>(null);
  const resultRef = useRef<PhotoPreviewResult | null>(null);
  const [rendering, setRendering] = useState(true);
  const revision = useRef(0);

  const scale = Math.min(
    1,
    PREVIEW_MAX_EDGE / Math.max(1, Math.max(settings.width, settings.height)),
  );
  const previewWidth = Math.max(1, Math.round(settings.width * scale));
  const previewHeight = Math.max(1, Math.round(settings.height * scale));

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = previewWidth;
    canvas.height = previewHeight;
  }, [previewWidth, previewHeight]);

  useEffect(() => {
    if (!provider || !source) return;
    const current = ++revision.current;
    setRendering(true);
    const timer = window.setTimeout(() => {
      void renderPhotoBlob(provider, source, settings, quality)
        .then(async (output) => {
          if (current !== revision.current) return;
          const url = URL.createObjectURL(output.blob);
          const bitmap = await createImageBitmap(output.blob);
          if (current !== revision.current) {
            bitmap.close();
            URL.revokeObjectURL(url);
            return;
          }
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext('2d', { alpha: false });
          if (canvas && ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          }
          bitmap.close();
          setResult((previous) => {
            if (previous) URL.revokeObjectURL(previous.url);
            const next = { ...output, url, bytes: output.blob.size };
            resultRef.current = next;
            return next;
          });
          setRendering(false);
        })
        .catch(() => {
          if (current === revision.current) setRendering(false);
        });
    }, 35);
    return () => window.clearTimeout(timer);
  }, [provider, source, settings, quality]);

  useEffect(
    () => () => {
      revision.current++;
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
      resultRef.current = null;
    },
    [],
  );

  return {
    canvasRef,
    result,
    rendering,
    size: { width: previewWidth, height: previewHeight },
  };
}
