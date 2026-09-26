import { describe, expect, it } from 'vitest';
import {
  frameFilename,
  frameIndexAtTime,
  frameIndexFromFilename,
  inferPresentedFps,
} from '../src/media/frameSequence';

describe('frame sequence helpers', () => {
  it('infers 29.97 fps even when a callback skips a presented frame', () => {
    const dt = 1 / 29.97;
    const samples = [
      { time: 0, presentedFrames: 1 },
      { time: dt, presentedFrames: 2 },
      { time: dt * 3, presentedFrames: 4 },
      { time: dt * 4, presentedFrames: 5 },
    ];
    expect(inferPresentedFps(samples)).toBe(29.97);
  });

  it('finds the frame at or before a playback timestamp', () => {
    expect(frameIndexAtTime([0, 0.04, 0.08], 0.079)).toBe(1);
    expect(frameIndexAtTime([0, 0.04, 0.08], 0.08)).toBe(2);
  });

  it('round-trips downloaded frame filenames', () => {
    expect(frameFilename(11)).toBe('frame_000012.png');
    expect(frameIndexFromFilename('frame_000012.png', 20)).toBe(11);
    expect(frameIndexFromFilename('ai-upscale-frame_000012-final.png', 20)).toBe(11);
  });

  it('accepts a trailing frame number when an AI tool changes the prefix', () => {
    expect(frameIndexFromFilename('generated_12.png', 20)).toBe(11);
    expect(frameIndexFromFilename('generated_21.png', 20)).toBeNull();
  });
});
