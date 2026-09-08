import { useEffect, useRef, useState } from 'react';

export interface GestureInfo {
  /** Pointer centroid in element-local pixels, at the time of the event. */
  x: number;
  y: number;
  /** Pointer centroid in viewport pixels. */
  clientX: number;
  clientY: number;
  /** Movement since the previous event, in pixels. */
  dx: number;
  dy: number;
  /** Pinch scale factor since the previous event (1 = unchanged). */
  scale: number;
  /** Two-finger rotation since the previous event, in radians. */
  rotation: number;
  pointers: number;
}

export interface GestureHandlers {
  onStart?: (info: GestureInfo) => void;
  onMove?: (info: GestureInfo) => void;
  onEnd?: () => void;
}

interface Point {
  x: number;
  y: number;
}

const centroid = (points: Point[]): Point => ({
  x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
  y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
});

function normaliseAngle(radians: number): number {
  while (radians > Math.PI) radians -= Math.PI * 2;
  while (radians < -Math.PI) radians += Math.PI * 2;
  return radians;
}

/**
 * Unified drag / pinch / rotate handling built on Pointer Events, the one input
 * model iOS Safari, desktop Safari and Chrome all agree on.
 *
 * All deltas are measured in *viewport* coordinates on purpose. Callers attach
 * these handlers to the very element they are moving, so measuring against the
 * element's own box would subtract the movement being applied and make dragging
 * track at roughly half speed.
 */
export function useGesture(
  ref: React.RefObject<HTMLElement | null>,
  handlers: GestureHandlers,
  enabled = true,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;

    /** Live pointer positions, in viewport coordinates. */
    const active = new Map<number, Point>();
    let lastCentre: Point | null = null;
    let lastSpread = 0;
    let lastAngle = 0;

    const measure = () => {
      const points = [...active.values()];
      const centre = centroid(points);
      if (points.length < 2) return { centre, spread: 0, angle: 0 };
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      return { centre, spread: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
    };

    const build = (centre: Point, delta: Point, scale: number, rotation: number): GestureInfo => {
      const rect = element.getBoundingClientRect();
      return {
        x: centre.x - rect.left,
        y: centre.y - rect.top,
        clientX: centre.x,
        clientY: centre.y,
        dx: delta.x,
        dy: delta.y,
        scale,
        rotation,
        pointers: active.size,
      };
    };

    const onDown = (event: PointerEvent) => {
      active.set(event.pointerId, { x: event.clientX, y: event.clientY });
      element.setPointerCapture(event.pointerId);
      const { centre, spread, angle } = measure();
      lastCentre = centre;
      lastSpread = spread;
      lastAngle = angle;
      event.preventDefault();
      event.stopPropagation();
      handlersRef.current.onStart?.(build(centre, { x: 0, y: 0 }, 1, 0));
    };

    const onMove = (event: PointerEvent) => {
      if (!active.has(event.pointerId)) return;
      active.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const { centre, spread, angle } = measure();
      const delta = lastCentre
        ? { x: centre.x - lastCentre.x, y: centre.y - lastCentre.y }
        : { x: 0, y: 0 };
      const pinching = active.size >= 2 && lastSpread > 4 && spread > 4;
      const info = build(
        centre,
        delta,
        pinching ? spread / lastSpread : 1,
        pinching ? normaliseAngle(angle - lastAngle) : 0,
      );
      lastCentre = centre;
      lastSpread = spread;
      lastAngle = angle;
      event.preventDefault();
      handlersRef.current.onMove?.(info);
    };

    const onUp = (event: PointerEvent) => {
      if (!active.delete(event.pointerId)) return;
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      if (active.size === 0) {
        lastCentre = null;
        handlersRef.current.onEnd?.();
        return;
      }
      // Lifting one finger of a pinch must not register as a jump.
      const { centre, spread, angle } = measure();
      lastCentre = centre;
      lastSpread = spread;
      lastAngle = angle;
    };

    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
  }, [ref, enabled]);
}

/**
 * Largest box of the given aspect ratio that fits inside the observed element.
 * Used to lay out the preview canvas; the returned pixel box is also what
 * gesture coordinates are normalised against.
 */
export function useFitBox(
  containerRef: React.RefObject<HTMLElement | null>,
  aspect: number,
  padding = 24,
): { width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const available = {
        width: Math.max(40, rect.width - padding),
        height: Math.max(40, rect.height - padding),
      };
      const scale = Math.min(available.width / aspect, available.height);
      setBox({
        width: Math.max(40, Math.round(scale * aspect)),
        height: Math.max(40, Math.round(scale)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('orientationchange', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('orientationchange', update);
    };
  }, [containerRef, aspect, padding]);

  return box;
}
