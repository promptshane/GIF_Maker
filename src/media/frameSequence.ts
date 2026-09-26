/** Pure helpers for the frame-by-frame video workflow. */

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Infer source FPS from rVFC samples. `presentedFrames` lets this stay accurate
 * even if the JavaScript callback misses one or more presented frames.
 */
export function inferPresentedFps(
  samples: Array<{ time: number; presentedFrames: number }>,
): number {
  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].time - samples[i - 1].time;
    const df = samples[i].presentedFrames - samples[i - 1].presentedFrames;
    if (dt > 0 && df > 0) intervals.push(dt / df);
  }
  const interval = median(intervals);
  if (!(interval > 0)) return 30;
  const raw = 1 / interval;
  const standards = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
  const nearest = standards.reduce((best, value) =>
    Math.abs(value - raw) < Math.abs(best - raw) ? value : best,
  standards[0]);
  return Math.abs(nearest - raw) <= Math.max(0.35, raw * 0.008)
    ? nearest
    : Math.round(raw * 100) / 100;
}

/** Frame index at or immediately before a playback timestamp. */
export function frameIndexAtTime(times: number[], time: number): number {
  if (times.length === 0) return 0;
  let lo = 0;
  let hi = times.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time + 1e-5) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, Math.min(times.length - 1, hi));
}

export function frameFilename(index: number): string {
  return `frame_${String(index + 1).padStart(6, '0')}.png`;
}

/**
 * Match an edited image back to a downloaded frame. Exact `frame_000123`
 * names are preferred, but a trailing number before the extension is accepted
 * so AI tools can add prefixes without breaking the round trip.
 */
export function frameIndexFromFilename(name: string, frameCount: number): number | null {
  const exact = name.match(/frame[\s_-]*0*(\d{1,7})/i);
  const fallback = name.match(/(\d{1,7})(?=\.[^.]+$)/);
  const value = Number((exact ?? fallback)?.[1]);
  if (!Number.isInteger(value) || value < 1 || value > frameCount) return null;
  return value - 1;
}
