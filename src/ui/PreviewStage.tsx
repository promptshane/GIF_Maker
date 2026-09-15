import { useEffect, useRef, useState } from 'react';
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
  previewLabel?: string;
}

/**
 * The preview canvas plus its direct-manipulation layer.
 *
 * Everything is edited on the preview itself rather than through numeric
 * fields: drag the body to move, drag the handle to resize (and rotate, for
 * stickers), or pinch anywhere on the selected item.
 *
 * Only the *selected* item draws an outline. Unselected items keep an
 * invisible hit area so a tap still picks them up, but with nothing selected
 * the stage shows exactly what the GIF will look like — tap empty space to
 * get there.
 */
export function PreviewStage(props: StageProps) {
  const { canvasRef, box, mode } = props;

  return (
    <div className="stage-inner" style={{ width: box.width, height: box.height }}>
      <canvas ref={canvasRef} aria-label={props.previewLabel ?? 'GIF preview'} />
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
          borderColor: selected ? 'var(--accent)' : 'transparent',
          boxShadow: selected ? undefined : 'none',
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
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const timerRef = useRef<number | null>(null);
  const alignedRef = useRef({ x: false, y: false });

  const showGuides = (next: { x: number | null; y: number | null }) => {
    if (next.x === null && next.y === null) return;
    setGuides(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setGuides({ x: null, y: null }), 700);
  };

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // Also catches precise alignment reached through the nudge controls.
  useEffect(() => {
    const selected = visible.find((region) => region.id === selectedId);
    if (!selected) return;
    const here = censorRectAt(selected, timeMs);
    let x: number | null = null;
    let y: number | null = null;
    for (const other of visible) {
      if (other.id === selected.id) continue;
      const there = censorRectAt(other, timeMs);
      const sameSize = Math.abs(here.w - there.w) < 0.0005 && Math.abs(here.h - there.h) < 0.0005;
      if (!sameSize) continue;
      if (Math.abs(here.x - there.x) < 0.0005) x = here.x;
      if (Math.abs(here.y - there.y) < 0.0005) y = here.y;
    }
    const aligned = { x: x !== null, y: y !== null };
    if ((aligned.x && !alignedRef.current.x) || (aligned.y && !alignedRef.current.y)) {
      showGuides({ x, y });
    }
    alignedRef.current = aligned;
  }, [censors, selectedId, timeMs]);

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
          peers={visible}
          onAlign={showGuides}
        />
      ))}
      {guides.x !== null && (
        <div className="alignment-guide vertical" style={{ left: `${guides.x * 100}%` }} aria-hidden="true" />
      )}
      {guides.y !== null && (
        <div className="alignment-guide horizontal" style={{ top: `${guides.y * 100}%` }} aria-hidden="true" />
      )}
    </div>
  );
}

/** How long a censor region's outline stays up after it is selected or moved. */
const CENSOR_OUTLINE_MS = 1100;

/**
 * A censor region's hit area, and a brief outline so you know which one you
 * are editing. The outline shows when the region is selected and again on
 * every change to it, then fades, so the censored result stays visible
 * without chrome on top of it. Size is set from the panel, not a handle.
 */
function CensorBox({
  region,
  timeMs,
  box,
  selected,
  onSelect,
  onChange,
  peers,
  onAlign,
}: {
  region: CensorRegion;
  timeMs: number;
  box: { width: number; height: number };
  selected: boolean;
  onSelect: () => void;
  onChange: (rect: { x: number; y: number; w: number; h: number }) => void;
  peers: CensorRegion[];
  onAlign: (guides: { x: number | null; y: number | null }) => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rect = censorRectAt(region, timeMs);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!selected) {
      setFlash(false);
      return;
    }
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), CENSOR_OUTLINE_MS);
    return () => window.clearTimeout(timer);
    // Re-arm on every geometry change, so the outline stays while dragging or nudging.
  }, [selected, rect.x, rect.y, rect.w, rect.h]);

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
      // Matching-size regions magnetise very slightly at their centre lines.
      // Six screen pixels is enough to make deliberate alignment easy without
      // making ordinary movement feel sticky.
      const snapX = 6 / Math.max(1, box.width);
      const snapY = 6 / Math.max(1, box.height);
      let alignedX = false;
      let alignedY = false;
      for (const peer of peers) {
        if (peer.id === region.id) continue;
        const there = censorRectAt(peer, timeMs);
        const sameSize = Math.abs(next.w - there.w) < 0.0005 && Math.abs(next.h - there.h) < 0.0005;
        if (!sameSize) continue;
        if (Math.abs(next.x - there.x) <= snapX) {
          next.x = there.x;
          alignedX = true;
        }
        if (Math.abs(next.y - there.y) <= snapY) {
          next.y = there.y;
          alignedY = true;
        }
      }
      if (alignedX || alignedY) {
        onAlign({ x: alignedX ? next.x : null, y: alignedY ? next.y : null });
      }
      onChange(next);
    },
  });

  const w = rect.w * box.width;
  const h = rect.h * box.height;
  const left = rect.x * box.width;
  const top = rect.y * box.height;

  return (
    <div
      ref={bodyRef}
      className={`selection-box censor${region.shape === 'circle' ? ' circle' : ''}${flash ? ' flash' : ''}`}
      data-selected={selected ? 'true' : undefined}
      style={{
        left: left - w / 2,
        top: top - h / 2,
        width: w,
        height: h,
      }}
    />
  );
}
