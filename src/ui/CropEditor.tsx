import { useEffect, useRef } from 'react';
import type { CropRect } from '../state/types';
import type { FrameImage } from '../media/frames';
import { MIN_CROP, clamp, normaliseCrop } from '../render/geometry';
import { useGesture } from './gestures';

interface CropEditorProps {
  /** Full, uncropped source frame to reframe against. */
  source: FrameImage | null;
  /**
   * Pixel size of the real source. The preview frame is a downscaled copy whose
   * rounding can put its aspect a fraction off, and the crop must be normalised
   * against exactly the dimensions the store uses or each edit would drift.
   */
  sourceWidth: number;
  sourceHeight: number;
  crop: CropRect;
  onChange: (crop: CropRect) => void;
  box: { width: number; height: number };
  /** Output aspect the crop is locked to. */
  outputWidth: number;
  outputHeight: number;
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';

const CORNERS: Array<{ id: Corner; label: string; right: boolean; bottom: boolean }> = [
  { id: 'nw', label: 'Resize crop area from the top left', right: false, bottom: false },
  { id: 'ne', label: 'Resize crop area from the top right', right: true, bottom: false },
  { id: 'sw', label: 'Resize crop area from the bottom left', right: false, bottom: true },
  { id: 'se', label: 'Resize crop area', right: true, bottom: true },
];

/**
 * Visual reframing of the source.
 *
 * The crop rectangle is locked to the output aspect ratio, so what is inside
 * the box is exactly what the GIF will contain — no letterboxing and no
 * stretching. Drag the body to move it, pinch to scale about its centre, or
 * drag any corner to resize against the opposite corner, which stays put.
 */
export function CropEditor({
  source,
  sourceWidth,
  sourceHeight,
  crop,
  onChange,
  box,
  outputWidth,
  outputHeight,
}: CropEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
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

  /** Normalised width per normalised height at the output aspect. */
  const ratio = (outputWidth / outputHeight) / (sourceWidth / sourceHeight);

  const commit = (next: CropRect) => {
    onChange(normaliseCrop(next, sourceWidth, sourceHeight, outputWidth, outputHeight));
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
        next.w = clamp(crop.w * info.scale, MIN_CROP, 1);
        next.h = next.w / ratio;
        next.x = cx - next.w / 2;
        next.y = cy - next.h / 2;
      }
      commit(next);
    },
  });

  /**
   * Resizes with the corner opposite the one being dragged pinned in place.
   * The pointer's offset from that anchor gives a wanted width and height;
   * the box follows whichever is larger at the locked aspect, so dragging
   * mostly sideways or mostly downwards both feel right.
   */
  const resizeFrom = (corner: (typeof CORNERS)[number], clientX: number, clientY: number) => {
    const overlay = layerRef.current?.getBoundingClientRect();
    if (!overlay) return;
    const anchorX = corner.right ? crop.x : crop.x + crop.w;
    const anchorY = corner.bottom ? crop.y : crop.y + crop.h;
    const px = (clientX - overlay.left) / box.width;
    const py = (clientY - overlay.top) / box.height;
    const wantW = corner.right ? px - anchorX : anchorX - px;
    const wantH = corner.bottom ? py - anchorY : anchorY - py;

    // Room from the anchor to the source edge in the drag direction.
    const roomW = corner.right ? 1 - anchorX : anchorX;
    const roomH = corner.bottom ? 1 - anchorY : anchorY;
    const maxW = Math.max(MIN_CROP, Math.min(roomW, roomH * ratio));
    const w = clamp(Math.max(wantW, wantH * ratio), MIN_CROP, maxW);
    const h = w / ratio;

    commit({
      x: corner.right ? anchorX : anchorX - w,
      y: corner.bottom ? anchorY : anchorY - h,
      w,
      h,
    });
  };

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
        {CORNERS.map((corner) => (
          <CornerHandle
            key={corner.id}
            label={corner.label}
            x={corner.right ? left + width : left}
            y={corner.bottom ? top + height : top}
            onDrag={(clientX, clientY) => resizeFrom(corner, clientX, clientY)}
          />
        ))}
      </div>
    </div>
  );
}

function CornerHandle({
  label,
  x,
  y,
  onDrag,
}: {
  label: string;
  x: number;
  y: number;
  onDrag: (clientX: number, clientY: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useGesture(ref, { onMove: (info) => onDrag(info.clientX, info.clientY) });
  return <div ref={ref} className="handle" style={{ left: x, top: y }} aria-label={label} />;
}
