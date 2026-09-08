import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FrameProvider } from '../media/frames';
import type { FramePlan } from '../render/timeline';
import { frameIndexAt } from '../render/timeline';
import { Compositor, composeFrame } from '../render/compose';
import type { RenderSettings } from '../export/renderPipeline';
import type { FrameImage } from '../media/frames';

/**
 * Preview rendering is capped at this long edge. The compositor work (censor
 * blurs in particular) is per-pixel, and a 720px canvas at 60fps is more than a
 * phone can spare. Everything in the render is proportional to canvas size, so
 * the preview stays a faithful scaled-down copy of the export.
 */
const PREVIEW_MAX_EDGE = 640;

/** How often the playhead is pushed into React state during playback. */
const PLAYHEAD_PUBLISH_MS = 80;

export interface PreviewPlayer {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  timeMs: number;
  playing: boolean;
  setPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  seek: (timeMs: number) => void;
  /** Canvas backing-store size actually used for the preview. */
  size: { width: number; height: number };
}

/**
 * An image to show instead of the timeline's own frame — used while scrubbing a
 * trim handle, where the point is to see a specific source frame.
 */
export interface PreviewOverride {
  frame: FrameImage | null;
  revision: number;
}

export function usePreviewPlayer(
  plan: FramePlan,
  settings: RenderSettings,
  provider: FrameProvider | null,
  override?: PreviewOverride,
): PreviewPlayer {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<Compositor | null>(null);
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(true);

  // Latest values, read inside the animation loop without restarting it.
  const planRef = useRef(plan);
  const settingsRef = useRef(settings);
  const providerRef = useRef(provider);
  const playingRef = useRef(playing);
  const overrideRef = useRef<PreviewOverride | undefined>(override);
  const timeRef = useRef(0);
  planRef.current = plan;
  settingsRef.current = settings;
  providerRef.current = provider;
  playingRef.current = playing;
  overrideRef.current = override;

  const scale = Math.min(
    1,
    PREVIEW_MAX_EDGE / Math.max(1, Math.max(settings.width, settings.height)),
  );
  const width = Math.max(1, Math.round(settings.width * scale));
  const height = Math.max(1, Math.round(settings.height * scale));

  // Created on demand rather than during render: React StrictMode mounts,
  // unmounts and remounts effects, and a compositor created once in render
  // would be disposed by the first cleanup and never rebuilt.
  const getCompositor = useCallback((): Compositor => {
    if (!compositorRef.current) compositorRef.current = new Compositor();
    return compositorRef.current;
  }, []);

  const draw = useCallback((atMs: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const compositor = getCompositor();
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const currentPlan = planRef.current;
    const current = settingsRef.current;
    const scaleNow = Math.min(
      1,
      PREVIEW_MAX_EDGE / Math.max(1, Math.max(current.width, current.height)),
    );
    const w = Math.max(1, Math.round(current.width * scaleNow));
    const h = Math.max(1, Math.round(current.height * scaleNow));

    const index = frameIndexAt(currentPlan, atMs);
    const frame = index >= 0 ? currentPlan.frames[index] : null;
    const scrubbed = overrideRef.current?.frame ?? null;
    const image = scrubbed ?? (frame ? providerRef.current?.getSync?.(frame.source) ?? null : null);

    composeFrame(compositor, {
      ctx,
      width: w,
      height: h,
      image: image?.image ?? null,
      imageWidth: image?.width ?? 0,
      imageHeight: image?.height ?? 0,
      fitMode: current.fitMode,
      crop: current.crop,
      background: current.background,
      stickers: current.stickers,
      censors: current.censors,
      // Overlay visibility follows the frame's own start time, so a scrub lands
      // on exactly what that GIF frame will contain.
      timeMs: frame ? frame.timeMs : atMs,
    });
  }, [getCompositor]);

  // Keep the backing store in step with the output size.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    draw(timeRef.current);
  }, [width, height, draw]);

  // Repaint when anything that affects the image changes while paused, and
  // whenever a newly decoded scrub frame arrives.
  useEffect(() => {
    if (!playingRef.current) draw(timeRef.current);
  }, [draw, settings, plan, provider, override?.revision, override?.frame]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastPublish = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(250, now - last);
      last = now;
      if (!playingRef.current) return;
      const duration = planRef.current.durationMs;
      if (duration <= 0) return;
      const next = (timeRef.current + dt) % duration;
      timeRef.current = next;
      draw(next);

      // The canvas redraws every frame, but publishing the playhead to React
      // re-renders the editor and every open panel. Doing that 60 times a
      // second is wasted work on a phone, and ~12Hz is plenty for a timecode
      // readout and for overlay handles following a keyframed region.
      if (now - lastPublish >= PLAYHEAD_PUBLISH_MS) {
        lastPublish = now;
        setTimeMs(next);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  // Clamp the playhead when the timeline shrinks under it.
  useEffect(() => {
    if (plan.durationMs > 0 && timeRef.current >= plan.durationMs) {
      timeRef.current = 0;
      setTimeMs(0);
    }
  }, [plan.durationMs]);

  useEffect(
    () => () => {
      compositorRef.current?.dispose();
      compositorRef.current = null;
    },
    [],
  );

  const seek = useCallback(
    (value: number) => {
      const duration = planRef.current.durationMs || 1;
      const clamped = Math.max(0, Math.min(duration - 0.001, value));
      timeRef.current = clamped;
      setTimeMs(clamped);
      draw(clamped);
    },
    [draw],
  );

  const togglePlay = useCallback(() => setPlaying((value) => !value), []);

  return {
    canvasRef,
    timeMs,
    playing,
    setPlaying,
    togglePlay,
    seek,
    size: { width, height },
  };
}
