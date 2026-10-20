import { useEffect, useRef, useState, type RefObject } from 'react';
import { clamp } from '../render/geometry';

/** Preview-only magnification; never affects the exported image. */
export const MAX_CENSOR_ZOOM = 8;
interface View { zoom: number; x: number; y: number }
interface Point { x: number; y: number }
const RESET: View = { zoom: 1, x: 0, y: 0 };
function constrain(v: View, w: number, h: number): View {
  const zoom = clamp(v.zoom, 1, MAX_CENSOR_ZOOM);
  return { zoom, x: clamp(v.x, w * (1 - zoom), 0), y: clamp(v.y, h * (1 - zoom), 0) };
}

export function useCensorPreviewZoom(
  viewportRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  box: { width: number; height: number },
  onZoomChange?: (zoom: number) => void,
) {
  const [view, setView] = useState<View>(RESET);
  const viewRef = useRef(view);
  const changeRef = useRef(onZoomChange);
  changeRef.current = onZoomChange;
  const pointerCountRef = useRef(0);
  const suppressCensorDragRef = useRef(false);

  const apply = (v: View) => {
    const next = constrain(v, box.width, box.height);
    const prior = viewRef.current;
    if (prior.zoom === next.zoom && prior.x === next.x && prior.y === next.y) return;
    viewRef.current = next;
    setView(next);
    if (prior.zoom !== next.zoom) changeRef.current?.(next.zoom);
  };
  const zoomAt = (amount: number, x: number, y: number) => {
    const previous = viewRef.current;
    const zoom = clamp(amount, 1, MAX_CENSOR_ZOOM);
    const ratio = zoom / previous.zoom;
    apply({ zoom, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio });
  };
  const zoomBy = (factor: number) => zoomAt(viewRef.current.zoom * factor, box.width / 2, box.height / 2);
  const resetZoom = () => apply(RESET);

  useEffect(() => { apply(RESET); }, [active, box.width, box.height]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !active) return;
    const pointers = new Map<number, Point>();
    let lastCentre: Point | null = null;
    let lastSpread = 0;
    let startedOnRegion = false;

    const measure = () => {
      const positions = [...pointers.values()];
      const centre = {
        x: positions.reduce((v, p) => v + p.x, 0) / positions.length,
        y: positions.reduce((v, p) => v + p.y, 0) / positions.length,
      };
      const spread = positions.length < 2 ? 0 : Math.hypot(
        positions[1].x - positions[0].x, positions[1].y - positions[0].y,
      );
      return { centre, spread };
    };
    const recalibrate = () => {
      if (!pointers.size) { lastCentre = null; lastSpread = 0; }
      else { const m = measure(); lastCentre = m.centre; lastSpread = m.spread; }
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest('.preview-zoom-controls')) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) startedOnRegion = event.target instanceof Element &&
        !!event.target.closest('.selection-box.censor');
      pointerCountRef.current = pointers.size;
      if (pointers.size >= 2) suppressCensorDragRef.current = true;
      recalibrate(); // Adding a finger must not cause a jump.
    };
    const move = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const { centre, spread } = measure();
      if (!lastCentre) { recalibrate(); return; }
      const previous = viewRef.current;
      if (pointers.size >= 2 && lastSpread > 4 && spread > 4) {
        const rect = viewport.getBoundingClientRect();
        const zoom = clamp(previous.zoom * spread / lastSpread, 1, MAX_CENSOR_ZOOM);
        const ratio = zoom / previous.zoom;
        apply({
          zoom,
          x: centre.x - rect.left - (lastCentre.x - rect.left - previous.x) * ratio,
          y: centre.y - rect.top - (lastCentre.y - rect.top - previous.y) * ratio,
        });
      } else if (pointers.size === 1 && previous.zoom > 1 &&
        (!startedOnRegion || suppressCensorDragRef.current)) {
        // Drag the empty background to pan; drag a region to move the censor.
        apply({
          ...previous, x: previous.x + centre.x - lastCentre.x,
          y: previous.y + centre.y - lastCentre.y,
        });
      }
      lastCentre = centre;
      lastSpread = spread;
    };
    const up = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      pointerCountRef.current = pointers.size;
      if (!pointers.size) suppressCensorDragRef.current = false;
      recalibrate();
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomAt(viewRef.current.zoom * Math.exp(-event.deltaY * 0.002),
        event.clientX - rect.left, event.clientY - rect.top);
    };
    const blur = () => {
      pointers.clear();
      pointerCountRef.current = 0;
      suppressCensorDragRef.current = false;
      recalibrate();
    };
    viewport.addEventListener('pointerdown', down, true);
    // The window listener also follows background pointers outside the frame.
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', blur);
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => {
      viewport.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', blur);
      viewport.removeEventListener('wheel', wheel);
      blur();
    };
  }, [active, box.width, box.height, viewportRef]);

  return { view, zoomBy, resetZoom, pointerCountRef, suppressCensorDragRef };
}
