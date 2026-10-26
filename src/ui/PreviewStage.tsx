import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrushPoint, CensorRegion, Sticker } from '../state/types';
import { censorRectAt, isActiveAt } from '../render/timeline';
import { clamp } from '../render/geometry';
import { useGesture } from './gestures';
import { useCensorPreviewZoom, MAX_CENSOR_ZOOM } from './useCensorPreviewZoom';

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
  /** Freeze playback for censor manipulation and return the exact displayed frame time. */
  onStartCensorEdit?: () => number;
  onEndCensorEdit?: () => void;
  onMoveCensor: (id: string, rect: { x: number; y: number; w: number; h: number }) => void;
  /** Output canvas dimensions, needed to convert sticker size to a box. */
  outputWidth: number;
  outputHeight: number;
  previewLabel?: string;
  onZoomChange?: (zoom: number) => void;
  brushActive?: boolean;
  brushSize?: number;
  onBrushStroke?: (points: BrushPoint[], size: number) => void;
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
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const { view, zoomBy, resetZoom, pointerCountRef, suppressCensorDragRef } =
    useCensorPreviewZoom(viewportRef, mode === 'censor' && !props.brushActive, box, props.onZoomChange);
  const [zoomControlsVisible, setZoomControlsVisible] = useState(false);
  const zoomControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showZoomControlsBriefly = useCallback(() => {
    setZoomControlsVisible(true);
    if (zoomControlsTimerRef.current !== null) clearTimeout(zoomControlsTimerRef.current);
    zoomControlsTimerRef.current = setTimeout(() => {
      setZoomControlsVisible(false);
      zoomControlsTimerRef.current = null;
    }, 1600);
  }, []);

  useEffect(() => {
    if (mode === 'censor') showZoomControlsBriefly();
    else setZoomControlsVisible(false);
    return () => {
      if (zoomControlsTimerRef.current !== null) {
        clearTimeout(zoomControlsTimerRef.current);
        zoomControlsTimerRef.current = null;
      }
    };
  }, [mode, view.zoom, showZoomControlsBriefly]);

  const nearZoomControls = (element: HTMLDivElement, x: number, y: number) => {
    const rect = element.getBoundingClientRect();
    return x >= rect.right - 160 && y >= rect.bottom - 64;
  };

  return (
    <div
      ref={viewportRef}
      className={`stage-inner${mode === 'censor' ? ' censor-viewport' : ''}`}
      style={{ width: box.width, height: box.height }}
      onPointerMove={(event) => {
        if (mode === 'censor' && event.pointerType === 'mouse' &&
            nearZoomControls(event.currentTarget, event.clientX, event.clientY)) {
          showZoomControlsBriefly();
        }
      }}
      onPointerDown={(event) => {
        if (mode === 'censor' && event.pointerType !== 'mouse' &&
            nearZoomControls(event.currentTarget, event.clientX, event.clientY)) {
          showZoomControlsBriefly();
        }
      }}
    >
      <div
        className="stage-content"
        style={{
          transformOrigin: '0 0',
          transform: mode === 'censor'
            ? `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
            : undefined,
        }}
      >
        <canvas ref={canvasRef} aria-label={props.previewLabel ?? 'GIF preview'} />
        {mode === 'stickers' && <StickerLayer {...props} />}
        {mode === 'censor' && !props.brushActive && (
          <CensorLayer
            {...props}
            zoom={view.zoom}
            pointerCountRef={pointerCountRef}
            suppressCensorDragRef={suppressCensorDragRef}
          />
        )}
        {mode === 'censor' && props.brushActive && props.onBrushStroke && (
          <BrushDrawingLayer
            box={box}
            size={props.brushSize ?? 0.07}
            onStroke={props.onBrushStroke}
          />
        )}
      </div>
      {mode === 'censor' && !props.brushActive && (
        <div className={`preview-zoom-controls${zoomControlsVisible ? ' is-visible' : ''}`} role="group" aria-label="Censor preview zoom">
          <button type="button" aria-label="Zoom out preview" disabled={view.zoom <= 1} onClick={() => zoomBy(1 / 1.5)}>−</button>
          <button type="button" className="preview-zoom-level" aria-label="Reset preview zoom" onClick={resetZoom} title="Reset preview zoom">
            {Math.round(view.zoom * 100)}%
          </button>
          <button type="button" aria-label="Zoom in preview" disabled={view.zoom >= MAX_CENSOR_ZOOM} onClick={() => zoomBy(1.5)}>+</button>
        </div>
      )}
    </div>
  );
}

/** Pointer drawing in output-space coordinates. Each completed stroke becomes
 * a separately selectable region. No image bytes are stored in the stroke. */
function BrushDrawingLayer({
  box, size, onStroke,
}: {
  box: { width: number; height: number };
  size: number;
  onStroke: (points: BrushPoint[], size: number) => void;
}) {
  const activePointer = useRef<number | null>(null);
  const strokeRef = useRef<BrushPoint[]>([]);
  const [previewPoints, setPreviewPoints] = useState<BrushPoint[]>([]);

  const pointAt = (element: HTMLDivElement, clientX: number, clientY: number): BrushPoint => {
    const rect = element.getBoundingClientRect();
    return {
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1),
    };
  };
  const clear = () => {
    activePointer.current = null;
    strokeRef.current = [];
    setPreviewPoints([]);
  };
  return (
    <div className="brush-draw-layer" aria-label="Paint censor brush"
      onPointerDown={(event) => {
        if (activePointer.current !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        activePointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = pointAt(event.currentTarget, event.clientX, event.clientY);
        strokeRef.current = [point];
        setPreviewPoints([point]);
      }}
      onPointerMove={(event) => {
        if (activePointer.current !== event.pointerId) return;
        const next = pointAt(event.currentTarget, event.clientX, event.clientY);
        const previous = strokeRef.current[strokeRef.current.length - 1];
        if (previous && Math.hypot((next.x - previous.x) * box.width,
          (next.y - previous.y) * box.height) < 2) return;
        if (strokeRef.current.length >= 1200) return;
        strokeRef.current = [...strokeRef.current, next];
        setPreviewPoints(strokeRef.current);
      }}
      onPointerUp={(event) => {
        if (activePointer.current !== event.pointerId) return;
        const completed = strokeRef.current;
        clear();
        if (completed.length) onStroke(completed, size);
      }}
      onPointerCancel={(event) => {
        if (activePointer.current === event.pointerId) clear();
      }}
    >
      {previewPoints.length > 0 && (
        <svg width="100%" height="100%" viewBox={`0 0 ${box.width} ${box.height}`}
          preserveAspectRatio="none" aria-hidden="true">
          <polyline points={previewPoints.map((p) => `${p.x * box.width},${p.y * box.height}`).join(' ')}
            fill="none" stroke="rgba(147, 107, 255, 0.75)"
            strokeWidth={size * Math.min(box.width, box.height)}
            strokeLinecap="round" strokeLinejoin="round" />
          {previewPoints.length === 1 && (
            <circle cx={previewPoints[0].x * box.width} cy={previewPoints[0].y * box.height}
              r={size * Math.min(box.width, box.height) / 2}
              fill="rgba(147, 107, 255, 0.75)" />
          )}
        </svg>
      )}
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
  onStartCensorEdit,
  onEndCensorEdit,
  onMoveCensor,
  zoom,
  pointerCountRef,
  suppressCensorDragRef,
}: StageProps & {
  zoom: number;
  pointerCountRef: { current: number };
  suppressCensorDragRef: { current: boolean };
}) {
  const visible = censors.filter((region) => isActiveAt(region.range, timeMs));
  const boxRegions = visible.filter((region) => region.shape !== 'brush');
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
    for (const other of boxRegions) {
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
      {visible.map((region) => region.shape === 'brush' ? (
        <BrushSelectionOutline key={region.id} region={region} box={box}
          selected={region.id === selectedId} />
      ) : (
        <CensorBox
          key={region.id}
          region={region}
          timeMs={timeMs}
          box={box}
          selected={region.id === selectedId}
          onSelect={() => onSelect(region.id)}
          onEditStart={onStartCensorEdit}
          onEditEnd={onEndCensorEdit}
          onChange={(rect) => onMoveCensor(region.id, rect)}
          peers={boxRegions}
          onAlign={showGuides}
          zoom={zoom}
          pointerCountRef={pointerCountRef}
          suppressCensorDragRef={suppressCensorDragRef}
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

/** Briefly highlight a selected brush stroke, without covering the result
 * permanently or interfering with painting and pan gestures. */
function BrushSelectionOutline({ region, box, selected }: {
  region: CensorRegion;
  box: { width: number; height: number };
  selected: boolean;
}) {
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!selected) { setFlash(false); return; }
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), CENSOR_OUTLINE_MS);
    return () => window.clearTimeout(timer);
  }, [selected, region.brush]);
  const stroke = region.brush;
  if (!flash || !stroke?.points.length) return null;
  const radius = stroke.size * Math.min(box.width, box.height) / 2;
  return (
    <svg className="brush-selection-outline" width="100%" height="100%"
      viewBox={`0 0 ${box.width} ${box.height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={stroke.points.map((p) => `${p.x * box.width},${p.y * box.height}`).join(' ')}
        fill="none" stroke="rgba(165, 130, 255, .32)"
        strokeWidth={radius * 2 + 4} strokeLinecap="round" strokeLinejoin="round" />
      {stroke.points.length === 1 && (
        <circle cx={stroke.points[0].x * box.width} cy={stroke.points[0].y * box.height}
          r={radius + 2} fill="rgba(165, 130, 255, .32)" />
      )}
    </svg>
  );
}

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
  onEditStart,
  onEditEnd,
  onChange,
  peers,
  onAlign,
  zoom,
  pointerCountRef,
  suppressCensorDragRef,
}: {
  region: CensorRegion;
  timeMs: number;
  box: { width: number; height: number };
  selected: boolean;
  onSelect: () => void;
  onEditStart?: () => number;
  onEditEnd?: () => void;
  onChange: (rect: { x: number; y: number; w: number; h: number }) => void;
  peers: CensorRegion[];
  onAlign: (guides: { x: number | null; y: number | null }) => void;
  zoom: number;
  pointerCountRef: { current: number };
  suppressCensorDragRef: { current: boolean };
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rect = censorRectAt(region, timeMs);
  const dragRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragTimeRef = useRef<number | null>(null);
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
    onStart: () => {
      if (pointerCountRef.current !== 1 || suppressCensorDragRef.current) return;
      onSelect();
      const frozen = onEditStart?.();
      dragTimeRef.current = frozen ?? timeMs;
      dragRectRef.current = censorRectAt(region, dragTimeRef.current);
    },
    onMove: (info) => {
      if (pointerCountRef.current !== 1 || suppressCensorDragRef.current) return;
      // Accumulate against the last gesture position rather than waiting for a
      // React rerender between pointer events. Fast drags therefore stay 1:1
      // with the finger/mouse instead of dropping movement and feeling elastic.
      const base = dragRectRef.current ?? rect;
      const next = {
        x: clamp(base.x + info.dx / (box.width * zoom), 0, 1),
        y: clamp(base.y + info.dy / (box.height * zoom), 0, 1),
        w: base.w,
        h: base.h,
      };
      dragRectRef.current = next;

      // Keep the alignment guide as a visual hint, but never alter geometry.
      // The old implementation physically snapped matching regions together
      // within six screen pixels, which made precise nearby placement feel magnetic.
      const guideX = 6 / Math.max(1, box.width * zoom);
      const guideY = 6 / Math.max(1, box.height * zoom);
      let x: number | null = null;
      let y: number | null = null;
      const editTime = dragTimeRef.current ?? timeMs;
      for (const peer of peers) {
        if (peer.id === region.id) continue;
        const there = censorRectAt(peer, editTime);
        const sameSize = Math.abs(next.w - there.w) < 0.0005 && Math.abs(next.h - there.h) < 0.0005;
        if (!sameSize) continue;
        if (Math.abs(next.x - there.x) <= guideX) x = there.x;
        if (Math.abs(next.y - there.y) <= guideY) y = there.y;
      }
      if (x !== null || y !== null) onAlign({ x, y });
      onChange(next);
    },
    onEnd: () => {
      dragRectRef.current = null;
      dragTimeRef.current = null;
      onEditEnd?.();
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
