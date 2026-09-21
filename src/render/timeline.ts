import type { CensorRegion, Direction, Sticker, TimeRange } from '../state/types';

/**
 * GIF stores frame delays in centiseconds, and every mainstream renderer
 * (Safari, Chrome, Firefox) rewrites a delay of 0 or 1cs to 10cs for
 * compatibility with very old files. 2cs is therefore the smallest delay that
 * actually plays as written, which caps real GIF playback at 50 FPS.
 */
export const MIN_DELAY_CS = 2;
export const MAX_GIF_FPS = 1000 / (MIN_DELAY_CS * 10); // 50

/** Hard ceiling so a long clip at a high frame rate cannot exhaust memory/time. */
export const MAX_FRAMES = 1500;

export type FrameSource =
  | { kind: 'photo'; index: number }
  | { kind: 'video'; time: number };

export interface PlannedFrame {
  /** Start of this frame on the output timeline, in milliseconds. */
  timeMs: number;
  /** Centisecond-quantised display duration, in milliseconds. */
  delayMs: number;
  source: FrameSource;
}

export interface FramePlan {
  frames: PlannedFrame[];
  /** Sum of all frame delays: the true playback length of the encoded GIF. */
  durationMs: number;
  /** The frame rate actually used after the GIF 50 FPS ceiling is applied. */
  fps: number;
  /** The frame rate the user asked for. */
  requestedFps: number;
  /**
   * True when the timeline hit `MAX_FRAMES` and was cut short. Surfaced in the
   * UI: dropping the end of someone's GIF without saying so is a silent failure.
   */
  truncated: boolean;
}

/** The sampling rate we can actually honour for a given user selection. */
export const effectiveFps = (fps: number): number => Math.min(fps, MAX_GIF_FPS);

const EMPTY_PLAN = (fps: number): FramePlan => ({
  frames: [],
  durationMs: 0,
  fps: effectiveFps(fps),
  requestedFps: fps,
  truncated: false,
});

/**
 * Rounds every delay to a whole centisecond while carrying the rounding error
 * forward, so a 24 FPS timeline stays 24 FPS on average instead of drifting to
 * 25 FPS (40ms) frame by frame.
 */
function quantiseDelays(frames: PlannedFrame[]): number {
  let carry = 0;
  let t = 0;
  const minMs = MIN_DELAY_CS * 10;
  for (const frame of frames) {
    const want = frame.delayMs + carry;
    const cs = Math.max(MIN_DELAY_CS, Math.round(want / 10));
    const actual = cs * 10;
    // Bound the carry so a run of floored delays cannot accumulate a huge debt.
    carry = Math.max(-minMs, Math.min(minMs, want - actual));
    frame.timeMs = t;
    frame.delayMs = actual;
    t += actual;
  }
  return t;
}

// -------------------------------------------------------------------- photos

/**
 * Samples a photo sequence on the frame-rate grid while snapping to each
 * photo's exact boundary, so a 0.35s photo stays 0.35s even at 10 FPS. The
 * extra in-photo samples exist so time-varying overlays (censor keyframes,
 * timed stickers) animate; `mergeStaticFrames` collapses them again when
 * nothing actually changes.
 */
export function buildPhotoPlan(durationsMs: number[], fps: number): FramePlan {
  if (durationsMs.length === 0) return EMPTY_PLAN(fps);
  const useFps = effectiveFps(fps);
  const frameMs = 1000 / useFps;
  const frames: PlannedFrame[] = [];

  let cursor = 0;
  for (let index = 0; index < durationsMs.length; index++) {
    const dur = Math.max(10, durationsMs[index]);
    const end = cursor + dur;
    let t = cursor;
    while (t < end - 1e-6) {
      const next = Math.min(end, t + frameMs);
      frames.push({ timeMs: t, delayMs: next - t, source: { kind: 'photo', index } });
      if (frames.length >= MAX_FRAMES) break;
      t = next;
    }
    cursor = end;
    if (frames.length >= MAX_FRAMES) break;
  }

  const durationMs = quantiseDelays(frames);
  return {
    frames,
    durationMs,
    fps: useFps,
    requestedFps: fps,
    truncated: frames.length >= MAX_FRAMES,
  };
}

// --------------------------------------------------------------------- video

export interface VideoPlanInput {
  trimStart: number;
  trimEnd: number;
  fps: number;
  speed: number;
  direction: Direction;
}

/**
 * Maps output frames back onto source timestamps.
 *
 * Boomerang emits the forward pass then the reverse pass with *both* endpoints
 * dropped (indices N-2 down to 1). Keeping them would show the first and last
 * source frames twice in a row, which reads as a stutter at the turnaround and
 * at the loop point.
 */
export function buildVideoPlan({
  trimStart,
  trimEnd,
  fps,
  speed,
  direction,
}: VideoPlanInput): FramePlan {
  const span = Math.max(0, trimEnd - trimStart);
  if (span <= 0) return EMPTY_PLAN(fps);

  const useFps = effectiveFps(fps);
  const frameMs = 1000 / useFps;
  const rate = Math.max(0.01, speed);
  const outSeconds = span / rate;

  // How many distinct source samples the forward pass needs.
  const wanted = Math.max(1, Math.round(outSeconds * useFps));
  const forwardCount = Math.min(MAX_FRAMES, wanted);

  // Advance the source by real time so `speed` genuinely changes playback rate.
  const sourceAt = (step: number): number =>
    Math.min(trimEnd, trimStart + Math.min(span, (step * frameMs * rate) / 1000));

  const times: number[] = [];
  if (direction === 'forward') {
    for (let i = 0; i < forwardCount; i++) times.push(sourceAt(i));
  } else if (direction === 'reverse') {
    for (let i = 0; i < forwardCount; i++) times.push(Math.max(trimStart, trimEnd - (sourceAt(i) - trimStart)));
  } else {
    for (let i = 0; i < forwardCount; i++) times.push(sourceAt(i));
    for (let i = forwardCount - 2; i >= 1; i--) times.push(sourceAt(i));
  }

  const frames: PlannedFrame[] = times
    .slice(0, MAX_FRAMES)
    .map((time, i) => ({ timeMs: i * frameMs, delayMs: frameMs, source: { kind: 'video' as const, time } }));

  const durationMs = quantiseDelays(frames);
  return {
    frames,
    durationMs,
    fps: useFps,
    requestedFps: fps,
    truncated: wanted > forwardCount || times.length > MAX_FRAMES,
  };
}

// ---------------------------------------------------------------- overlays

export const isActiveAt = (range: TimeRange | null, timeMs: number): boolean =>
  range === null || (timeMs >= range.startMs && timeMs < range.endMs);

/**
 * Position of a censor region at a point in time. With a single keyframe the
 * region is static; with several the rectangle is linearly interpolated so it
 * can follow a moving subject.
 */
export function censorRectAt(
  region: CensorRegion,
  timeMs: number,
): { x: number; y: number; w: number; h: number } {
  const keys = region.keyframes;
  if (keys.length === 0) return { x: 0.5, y: 0.5, w: 0.3, h: 0.3 };
  if (keys.length === 1 || timeMs <= keys[0].t) {
    const k = keys[0];
    return { x: k.x, y: k.y, w: k.w, h: k.h };
  }
  const last = keys[keys.length - 1];
  if (timeMs >= last.t) return { x: last.x, y: last.y, w: last.w, h: last.h };

  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= timeMs) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  const u = span <= 0 ? 0 : (timeMs - a.t) / span;
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    w: a.w + (b.w - a.w) * u,
    h: a.h + (b.h - a.h) * u,
  };
}

/**
 * Keeps censor tracking attached to the same source motion when video speed
 * changes. Censor keyframes and ranges live on the output timeline, whose
 * duration is inversely proportional to playback speed.
 */
export function retimeCensorForSpeed(
  region: CensorRegion,
  oldSpeed: number,
  newSpeed: number,
): CensorRegion {
  const before = Math.max(0.01, oldSpeed);
  const after = Math.max(0.01, newSpeed);
  const factor = before / after;
  if (Math.abs(factor - 1) < 1e-12) return region;
  return {
    ...region,
    range: region.range
      ? { startMs: region.range.startMs * factor, endMs: region.range.endMs * factor }
      : null,
    keyframes: region.keyframes.map((key) => ({ ...key, t: key.t * factor })),
  };
}

/**
 * Identifies what a frame will actually look like, ignoring pixel content that
 * cannot change (a photo shown twice in a row is byte-identical). Video frames
 * always get a unique signature because their source timestamp differs.
 */
export function frameSignature(
  frame: PlannedFrame,
  stickers: Sticker[],
  censors: CensorRegion[],
): string {
  if (frame.source.kind === 'video') return `v${frame.source.time.toFixed(4)}#${frame.timeMs}`;
  const parts: string[] = [`p${frame.source.index}`];
  for (const s of stickers) parts.push(isActiveAt(s.range, frame.timeMs) ? '1' : '0');
  for (const c of censors) {
    if (!isActiveAt(c.range, frame.timeMs)) {
      parts.push('0');
      continue;
    }
    const r = censorRectAt(c, frame.timeMs);
    // Quantised to ~0.1% of the canvas: finer differences are sub-pixel.
    parts.push(
      `${Math.round(r.x * 1000)},${Math.round(r.y * 1000)},${Math.round(r.w * 1000)},${Math.round(r.h * 1000)}`,
    );
  }
  return parts.join('|');
}

/**
 * Collapses runs of visually identical photo frames into a single GIF frame with
 * a longer delay. This is what lets a 5-photo slideshow encode as 5 frames
 * instead of 75, without giving up per-frame sampling when overlays animate.
 */
export function mergeStaticFrames(
  plan: FramePlan,
  stickers: Sticker[],
  censors: CensorRegion[],
): FramePlan {
  if (plan.frames.length === 0) return plan;
  const out: PlannedFrame[] = [];
  let prevSig: string | null = null;

  for (const frame of plan.frames) {
    const sig = frameSignature(frame, stickers, censors);
    const prev = out[out.length - 1];
    if (prev && sig === prevSig && frame.source.kind === 'photo') {
      // GIF delays are 16-bit centiseconds; cap a merged run at ~655s.
      if (prev.delayMs + frame.delayMs <= 655_000) {
        prev.delayMs += frame.delayMs;
        continue;
      }
    }
    out.push({ ...frame });
    prevSig = sig;
  }

  let t = 0;
  for (const frame of out) {
    frame.timeMs = t;
    t += frame.delayMs;
  }
  return { ...plan, frames: out, durationMs: t };
}

/** Index of the frame visible at `timeMs`, or -1 for an empty plan. */
export function frameIndexAt(plan: FramePlan, timeMs: number): number {
  const frames = plan.frames;
  if (frames.length === 0) return -1;
  const t = ((timeMs % plan.durationMs) + plan.durationMs) % plan.durationMs;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].timeMs <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
