import { useRef } from 'react';
import type { CensorRegion, Sticker } from '../state/types';
import { censorRectAt, isActiveAt } from '../render/timeline';
import { clamp } from '../render/geometry';
import { useGesture } from './gestures';

export type StageMode = 'view' | 'stickers' | 'censor';

interface StageProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Displayed size of the canvas in CSS pixels. */
  box: { width: number; height: number };
  mode: StageMode;
  timeMs: number;
  stickers: Sticker[];
  censors: CensorRegion[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMoveSticker: (id: string, patch: Partial<Sticker>) => void;
  onMoveCensor: (id: string, rect: { x: number; y: number; w: number; h: number }) => void;
  /** Output canvas dimensions, needed to convert sticker size to a box. */
  outputWidth: number;
  outputHeight: number;
}

/**
 * The preview canvas plus its direct-manipulation layer.
 *
 * Everything is edited on the preview itself rather than through numeric
 * fields: drag the body to move, drag the handle to resize (and rotate, for
 * stickers), or pinch anywhere on the selected item.
 */
export function PreviewStage(props: StageProps) {
  const { canvasRef, box, mode } = props;

  return (
    <div className="stage-inner" style={{ width: box.width, height: box.height }}>
      <canvas ref={canvasRef} aria-label="GIF preview" />
      {mode === 'stickers' && <StickerLayer {...props} />}
      {mode === 'censor' && <CensorLayer {...props} />}
    </div>
  );
}

/** Normalised half-extent of a sticker's glyph box on the output canvas. */
function stickerHalfExtent(sticker: Sticker, outW: number, outH: number) {
  const base = Math.min(outW, outH);
  const side = sticker.size * base;
  return { hx: side / 2 / outW, hy: side / 2 / outH };
}

function StickerLayer({
  box,
  timeMs,
  stickers,
  selectedId,
  onSelect,
  onMoveSticker,
  outputWidth,
  outputHeight,
}: StageProps) {
  const visible = stickers.filter((sticker) => isActiveAt(sticker.range, timeMs));
  return (
    <div className="overlay-layer" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onSelect(null);
    }}>
      {visible.map((sticker) => (
        <StickerBox
          key={sticker.id}
          sticker={sticker}
          box={box}
          selected={sticker.id === selectedId}
          onSelect={() => onSelect(sticker.id)}
          onChange={(patch) => onMoveSticker(sticker.id, patch)}
          outputWidth={outputWidth}
          outputHeight={outputHeight}
        />
      ))}
    </div>
  );
}

function StickerBox({
  sticker,
  box,
  selected,
  onSelect,
  onChange,
  outputWidth,
  outputHeight,
}: {
  sticker: Sticker;
  box: { width: number; height: number };
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<Sticker>) => void;
  outputWidth: number;
  outputHeight: number;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const { hx, hy } = stickerHalfExtent(sticker, outputWidth, outputHeight);

  useGesture(bodyRef, {
    onStart: onSelect,
    onMove: (info) => {
      const patch: Partial<Sticker> = {
        x: clamp(sticker.x + info.dx / box.width, -0.2, 1.2),
        y: clamp(sticker.y + info.dy / box.height, -0.2, 1.2),
      };
      if (info.pointers >= 2) {
        patch.size = clamp(sticker.size * info.scale, 0.03, 3);
        patch.rotation = sticker.rotation + info.rotation;
      }
      onChange(patch);
    },
  });

  // The corner handle sets size from the pointer's distance to the sticker
  // centre and rotation from its angle — the standard one-finger transform.
  useGesture(handleRef, {
    onStart: onSelect,
    onMove: (info) => {
      const overlay = handleRef.current?.parentElement?.getBoundingClientRect();
      if (!overlay) return;
      const centreX = overlay.left + sticker.x * box.width;
      const centreY = overlay.top + sticker.y * box.height;
      const vx = info.clientX - centreX;
      const vy = info.clientY - centreY;

      // The handle sits at a corner, so centre-to-pointer distance is
      // (side / 2) * sqrt(2).
      const sideCss = (Math.hypot(vx, vy) / Math.SQRT2) * 2;
      const cssPerOutputPx = box.width / Math.max(1, outputWidth);
      const base = Math.min(outputWidth, outputHeight);
      onChange({
        size: clamp(sideCss / cssPerOutputPx / base, 0.03, 3),
        rotation: Math.atan2(vy, vx) - Math.PI / 4,
      });
    },
  });

  const w = hx * 2 * box.width;
  const h = hy * 2 * box.height;
  const left = sticker.x * box.width;
  const top = sticker.y * box.height;

  return (
    <>
      <div
        ref={bodyRef}
        className="selection-box"
        style={{
          left: left - w / 2,
          top: top - h / 2,
          width: w,
          height: h,
          transform: `rotate(${sticker.rotation}rad)`,
          borderColor: selected ? 'var(--accent)' : 'rgba(255,255,255,0.35)',
          borderStyle: selected ? 'solid' : 'dashed',
        }}
      />
      {selected && (
        <div
          ref={handleRef}
          className="handle"
          style={{
            left: left + (Math.cos(sticker.rotation + Math.PI / 4) * Math.SQRT2 * w) / 2,
            top: top + (Math.sin(sticker.rotation + Math.PI / 4) * Math.SQRT2 * h) / 2,
          }}
          aria-label="Resize and rotate sticker"
        />
      )}
    </>
  );
}

function CensorLayer({
  box,
  timeMs,
  censors,
  selectedId,
  onSelect,
  onMoveCensor,
}: StageProps) {
  const visible = censors.filter((region) => isActiveAt(region.range, timeMs));
  return (
    <div className="overlay-layer" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onSelect(null);
    }}>
      {visible.map((region) => (
        <CensorBox
          key={region.id}
          region={region}
          timeMs={timeMs}
          box={box}
          selected={region.id === selectedId}
          onSelect={() => onSelect(region.id)}
          onChange={(rect) => onMoveCensor(region.id, rect)}
        />
      ))}
    </div>
  );
}

function CensorBox({
  region,
  timeMs,
  box,
  selected,
  onSelect,
  onChange,
}: {
  region: CensorRegion;
  timeMs: number;
  box: { width: number; height: number };
  selected: boolean;
  onSelect: () => void;
  onChange: (rect: { x: number; y: number; w: number; h: number }) => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const rect = censorRectAt(region, timeMs);

  useGesture(bodyRef, {
    onStart: onSelect,
    onMove: (info) => {
      const next = {
        x: clamp(rect.x + info.dx / box.width, 0, 1),
        y: clamp(rect.y + info.dy / box.height, 0, 1),
        w: rect.w,
        h: rect.h,
      };
      if (info.pointers >= 2) {
        next.w = clamp(rect.w * info.scale, 0.02, 2);
        next.h = clamp(rect.h * info.scale, 0.02, 2);
      }
      onChange(next);
    },
  });

  // Resizes about the centre so the censored subject stays covered while sizing.
  useGesture(handleRef, {
    onStart: onSelect,
    onMove: (info) => {
      const overlay = handleRef.current?.parentElement?.getBoundingClientRect();
      if (!overlay) return;
      const centreX = overlay.left + rect.x * box.width;
      const centreY = overlay.top + rect.y * box.height;
      onChange({
        x: rect.x,
        y: rect.y,
        w: clamp((Math.abs(info.clientX - centreX) * 2) / box.width, 0.02, 2),
        h: clamp((Math.abs(info.clientY - centreY) * 2) / box.height, 0.02, 2),
      });
    },
  });

  const w = rect.w * box.width;
  const h = rect.h * box.height;
  const left = rect.x * box.width;
  const top = rect.y * box.height;

  return (
    <>
      <div
        ref={bodyRef}
        className={`selection-box${region.shape === 'circle' ? ' circle' : ''}`}
        style={{
          left: left - w / 2,
          top: top - h / 2,
          width: w,
          height: h,
          borderColor: selected ? 'var(--accent)' : 'rgba(255,255,255,0.35)',
          borderStyle: selected ? 'solid' : 'dashed',
        }}
      />
      {selected && (
        <div
          ref={handleRef}
          className="handle"
          style={{ left: left + w / 2, top: top + h / 2 }}
          aria-label="Resize censor region"
        />
      )}
    </>
  );
}
