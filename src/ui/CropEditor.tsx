import { useEffect, useRef } from 'react';
import type { CropRect } from '../state/types';
import type { FrameImage } from '../media/frames';
import { clamp, normaliseCrop } from '../render/geometry';
import { useGesture } from './gestures';

interface CropEditorProps {
  /** Full, uncropped source frame to reframe against. */
  source: FrameImage | null;
  crop: CropRect;
  onChange: (crop: CropRect) => void;
  box: { width: number; height: number };
  /** Output aspect the crop is locked to. */
  outputWidth: number;
  outputHeight: number;
}

/**
 * Visual reframing of the source.
 *
 * The crop rectangle is locked to the output aspect ratio, so what is inside
 * the box is exactly what the GIF will contain — no letterboxing and no
 * stretching. Drag to move, pinch or drag the corner to resize.
 */
export function CropEditor({
  source,
  crop,
  onChange,
  box,
  outputWidth,
  outputHeight,
}: CropEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || box.width < 1) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#08080c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (source) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source.image, 0, 0, source.width, source.height, 0, 0, canvas.width, canvas.height);
    }
  }, [source, box.width, box.height]);

  const commit = (next: CropRect) => {
    if (!source) return;
    onChange(normaliseCrop(next, source.width, source.height, outputWidth, outputHeight));
  };

  useGesture(bodyRef, {
    onMove: (info) => {
      const next: CropRect = {
        x: clamp(crop.x + info.dx / box.width, -1, 1),
        y: clamp(crop.y + info.dy / box.height, -1, 1),
        w: crop.w,
        h: crop.h,
      };
      if (info.pointers >= 2 && info.scale !== 1) {
        // Grow/shrink around the rectangle's own centre.
        const cx = crop.x + crop.w / 2;
        const cy = crop.y + crop.h / 2;
        next.w = clamp(crop.w * info.scale, 0.05, 1);
        next.h = clamp(crop.h * info.scale, 0.05, 1);
        next.x = cx - next.w / 2;
        next.y = cy - next.h / 2;
      }
      commit(next);
    },
  });

  // Resize about the rectangle's centre, so the subject you framed stays
  // framed. `normaliseCrop` also preserves the centre, so the two agree.
  useGesture(handleRef, {
    onMove: (info) => {
      const overlay = layerRef.current?.getBoundingClientRect();
      if (!overlay) return;
      const centreX = crop.x + crop.w / 2;
      const centreY = crop.y + crop.h / 2;
      const centrePx = overlay.left + centreX * box.width;
      const width = clamp((Math.abs(info.clientX - centrePx) * 2) / box.width, 0.05, 1);
      commit({ x: centreX - width / 2, y: centreY - crop.h / 2, w: width, h: crop.h });
    },
  });

  const left = crop.x * box.width;
  const top = crop.y * box.height;
  const width = crop.w * box.width;
  const height = crop.h * box.height;

  return (
    <div className="stage-inner" style={{ width: box.width, height: box.height }}>
      <canvas ref={canvasRef} aria-label="Crop source" />
      <div className="overlay-layer" ref={layerRef}>
        {/* Dim everything outside the crop so the framing reads at a glance.
            Four rects rather than a huge box-shadow, because the stage no
            longer clips its overflow. */}
        <div className="crop-dim" style={{ left: 0, top: 0, right: 0, height: Math.max(0, top) }} />
        <div
          className="crop-dim"
          style={{ left: 0, top: top + height, right: 0, bottom: 0 }}
        />
        <div className="crop-dim" style={{ left: 0, top, width: Math.max(0, left), height }} />
        <div className="crop-dim" style={{ left: left + width, top, right: 0, height }} />
        <div className="crop-frame" style={{ left, top, width, height }} />
        <div
          ref={bodyRef}
          style={{
            position: 'absolute',
            left,
            top,
            width,
            height,
            touchAction: 'none',
          }}
          aria-label="Move crop area"
        />
        <div
          ref={handleRef}
          className="handle"
          style={{ left: left + width, top: top + height }}
          aria-label="Resize crop area"
        />
      </div>
    </div>
  );
}
