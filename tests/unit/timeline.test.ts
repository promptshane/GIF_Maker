import { describe, expect, it } from 'vitest';
import {
  MAX_FRAMES,
  MAX_GIF_FPS,
  buildPhotoPlan,
  buildVideoPlan,
  censorRectAt,
  effectiveFps,
  frameIndexAt,
  isActiveAt,
  mergeStaticFrames,
  retimeCensorForSpeed,
} from '../../src/render/timeline';
import type { CensorRegion, Sticker } from '../../src/state/types';

const videoTimes = (plan: ReturnType<typeof buildVideoPlan>) =>
  plan.frames.map((f) => (f.source.kind === 'video' ? f.source.time : NaN));

describe('photo timing', () => {
  it('honours each photo exact duration', () => {
    const plan = buildPhotoPlan([1500, 300, 720], 15);
    expect(plan.durationMs).toBe(2520);
  });

  it('emits at least one frame for a photo shorter than one frame interval', () => {
    const plan = buildPhotoPlan([30], 10);
    expect(plan.frames.length).toBeGreaterThanOrEqual(1);
    // GIF delays are centiseconds with a 2cs floor.
    expect(plan.durationMs).toBeGreaterThanOrEqual(20);
  });

  it('samples within a photo so overlays can animate', () => {
    const plan = buildPhotoPlan([1000], 10);
    expect(plan.frames).toHaveLength(10);
    expect(plan.frames.every((f) => f.source.kind === 'photo' && f.source.index === 0)).toBe(true);
  });

  it('merges identical consecutive frames back into one GIF frame', () => {
    const plan = mergeStaticFrames(buildPhotoPlan([1000, 500], 20), [], []);
    expect(plan.frames).toHaveLength(2);
    expect(plan.frames[0].delayMs).toBe(1000);
    expect(plan.frames[1].delayMs).toBe(500);
    expect(plan.durationMs).toBe(1500);
  });

  it('keeps separate frames where a timed sticker appears', () => {
    const sticker: Sticker = {
      id: 's', emoji: '★', x: 0.5, y: 0.5, size: 0.2, rotation: 0,
      range: { startMs: 400, endMs: 700 },
    };
    const plan = mergeStaticFrames(buildPhotoPlan([1000], 10), [sticker], []);
    // off -> on -> off is three distinct runs.
    expect(plan.frames).toHaveLength(3);
    expect(plan.durationMs).toBe(1000);
  });

  it('keeps separate frames where a censor region moves', () => {
    const region: CensorRegion = {
      id: 'c', shape: 'rect', effect: 'blur', strength: 0.5, range: null,
      keyframes: [
        { t: 0, x: 0.2, y: 0.5, w: 0.2, h: 0.2 },
        { t: 1000, x: 0.8, y: 0.5, w: 0.2, h: 0.2 },
      ],
    };
    const plan = mergeStaticFrames(buildPhotoPlan([1000], 10), [], [region]);
    expect(plan.frames).toHaveLength(10);
  });
});

describe('video timing', () => {
  const base = { trimStart: 1, trimEnd: 3, fps: 10, speed: 1, direction: 'forward' as const };

  it('forward samples the trim window in order', () => {
    const plan = buildVideoPlan(base);
    const times = videoTimes(plan);
    expect(plan.frames).toHaveLength(20);
    expect(times[0]).toBeCloseTo(1, 5);
    expect(times[times.length - 1]).toBeCloseTo(2.9, 5);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('reverse samples the same window backwards', () => {
    const times = videoTimes(buildVideoPlan({ ...base, direction: 'reverse' }));
    expect(times[0]).toBeCloseTo(3, 5);
    expect(times[times.length - 1]).toBeCloseTo(1.1, 5);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('boomerang drops both turnaround frames so the loop never stalls', () => {
    const forward = buildVideoPlan(base);
    const boomerang = buildVideoPlan({ ...base, direction: 'boomerang' });
    expect(boomerang.frames).toHaveLength(forward.frames.length * 2 - 2);

    const times = videoTimes(boomerang);
    // No two neighbours share a timestamp, including across the loop point.
    for (let i = 1; i < times.length; i++) expect(times[i]).not.toBeCloseTo(times[i - 1], 6);
    expect(times[0]).not.toBeCloseTo(times[times.length - 1], 6);
    // It really does go out and back.
    expect(Math.max(...times)).toBeCloseTo(times[forward.frames.length - 1], 5);
  });

  it('speed changes the output duration, not the trim window', () => {
    const normal = buildVideoPlan(base);
    const double = buildVideoPlan({ ...base, speed: 2 });
    const half = buildVideoPlan({ ...base, speed: 0.5 });
    expect(double.durationMs).toBeCloseTo(normal.durationMs / 2, -1);
    expect(half.durationMs).toBeCloseTo(normal.durationMs * 2, -1);
    // The source range covered is the same either way.
    for (const plan of [normal, double, half]) {
      const times = videoTimes(plan);
      expect(Math.min(...times)).toBeGreaterThanOrEqual(base.trimStart - 1e-6);
      expect(Math.max(...times)).toBeLessThanOrEqual(base.trimEnd + 1e-6);
    }
  });

  it('frame rate changes the frame count but not the duration', () => {
    const slow = buildVideoPlan({ ...base, fps: 10 });
    const fast = buildVideoPlan({ ...base, fps: 30 });
    expect(fast.frames.length).toBeCloseTo(slow.frames.length * 3, -1);
    expect(fast.durationMs).toBeCloseTo(slow.durationMs, -2);
  });

  it('caps playback at the fastest rate a GIF can actually play', () => {
    expect(effectiveFps(60)).toBe(MAX_GIF_FPS);
    const plan = buildVideoPlan({ ...base, fps: 60 });
    expect(plan.fps).toBe(MAX_GIF_FPS);
    expect(plan.requestedFps).toBe(60);
    // Every delay is at least 2cs, which is what makes 50 FPS the ceiling.
    expect(Math.min(...plan.frames.map((f) => f.delayMs))).toBeGreaterThanOrEqual(20);
  });

  it('keeps the average frame rate correct despite centisecond rounding', () => {
    // 24 FPS is 41.67ms, which cannot be expressed in whole centiseconds.
    const plan = buildVideoPlan({ ...base, fps: 24 });
    const expected = (plan.frames.length * 1000) / 24;
    expect(Math.abs(plan.durationMs - expected)).toBeLessThan(25);
  });

  it('reports truncation instead of silently shortening the timeline', () => {
    const ok = buildVideoPlan({ ...base, trimEnd: 3 });
    expect(ok.truncated).toBe(false);
    const tooLong = buildVideoPlan({ trimStart: 0, trimEnd: 600, fps: 30, speed: 1, direction: 'forward' });
    expect(tooLong.truncated).toBe(true);
    expect(tooLong.frames.length).toBeLessThanOrEqual(MAX_FRAMES);
  });

  it('returns an empty plan for an empty trim window', () => {
    const plan = buildVideoPlan({ ...base, trimStart: 2, trimEnd: 2 });
    expect(plan.frames).toHaveLength(0);
    expect(plan.durationMs).toBe(0);
  });
});

describe('overlay timing', () => {
  it('treats a null range as always visible', () => {
    expect(isActiveAt(null, 0)).toBe(true);
    expect(isActiveAt(null, 99999)).toBe(true);
  });

  it('applies a range as a half-open interval', () => {
    const range = { startMs: 100, endMs: 200 };
    expect(isActiveAt(range, 99)).toBe(false);
    expect(isActiveAt(range, 100)).toBe(true);
    expect(isActiveAt(range, 199)).toBe(true);
    expect(isActiveAt(range, 200)).toBe(false);
  });

  it('interpolates a censor region between keyframes', () => {
    const region: CensorRegion = {
      id: 'c', shape: 'rect', effect: 'pixelate', strength: 1, range: null,
      keyframes: [
        { t: 0, x: 0.1, y: 0.2, w: 0.1, h: 0.1 },
        { t: 1000, x: 0.9, y: 0.6, w: 0.5, h: 0.3 },
      ],
    };
    expect(censorRectAt(region, 0)).toEqual({ x: 0.1, y: 0.2, w: 0.1, h: 0.1 });
    const mid = censorRectAt(region, 500);
    expect(mid.x).toBeCloseTo(0.5, 6);
    expect(mid.y).toBeCloseTo(0.4, 6);
    expect(mid.w).toBeCloseTo(0.3, 6);
    expect(mid.h).toBeCloseTo(0.2, 6);
    // Clamped outside the keyframe range rather than extrapolated.
    expect(censorRectAt(region, 5000)).toEqual({ x: 0.9, y: 0.6, w: 0.5, h: 0.3 });
  });

  it('retimes keyframes and visibility ranges when playback speed changes', () => {
    const region: CensorRegion = {
      id: 'c', shape: 'rect', effect: 'blur', strength: 0.5,
      range: { startMs: 250, endMs: 1500 },
      keyframes: [
        { t: 0, x: 0.2, y: 0.5, w: 0.2, h: 0.2 },
        { t: 1000, x: 0.8, y: 0.5, w: 0.2, h: 0.2 },
      ],
    };
    const slowed = retimeCensorForSpeed(region, 1, 0.5);
    expect(slowed.range).toEqual({ startMs: 500, endMs: 3000 });
    expect(slowed.keyframes.map((key) => key.t)).toEqual([0, 2000]);
    // Geometry is untouched; only its output-timeline timestamps move.
    expect(slowed.keyframes[1].x).toBe(0.8);
    // Returning to the original speed returns the authored timing too.
    const restored = retimeCensorForSpeed(slowed, 0.5, 1);
    expect(restored.range).toEqual(region.range);
    expect(restored.keyframes).toEqual(region.keyframes);
  });

  it('holds position with a single keyframe', () => {
    const region: CensorRegion = {
      id: 'c', shape: 'circle', effect: 'blur', strength: 0.5, range: null,
      keyframes: [{ t: 0, x: 0.4, y: 0.4, w: 0.2, h: 0.2 }],
    };
    expect(censorRectAt(region, 9999)).toEqual({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
  });
});

describe('playhead lookup', () => {
  it('finds the frame showing at a given time and wraps the loop', () => {
    const plan = mergeStaticFrames(buildPhotoPlan([1000, 500], 10), [], []);
    expect(frameIndexAt(plan, 0)).toBe(0);
    expect(frameIndexAt(plan, 999)).toBe(0);
    expect(frameIndexAt(plan, 1000)).toBe(1);
    expect(frameIndexAt(plan, 1499)).toBe(1);
    expect(frameIndexAt(plan, 1500)).toBe(0);
    expect(frameIndexAt(plan, -1)).toBe(1);
  });

  it('reports -1 for an empty plan', () => {
    expect(frameIndexAt(buildPhotoPlan([], 15), 0)).toBe(-1);
  });
});
