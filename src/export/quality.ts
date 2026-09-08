import type { QualityLevel } from '../state/types';

/** Colour-space resolution used when mapping a pixel to the nearest palette entry. */
export type LookupFormat = 'rgb565' | 'rgb444';

export interface QualityProfile {
  id: QualityLevel;
  label: string;
  /** Short, jargon-free description shown in the export sheet. */
  blurb: string;
  /**
   * Colours in the GIF palette. A GIF colour table holds at most 256 entries and
   * we reserve one for transparency, so 255 is the ceiling.
   */
  maxColors: number;
  /**
   * Bucket resolution for the nearest-colour lookup table. rgb444 needs a 4096
   * entry table, rgb565 needs 65536; the finer table maps colours more
   * precisely at the cost of a slightly slower one-off build.
   */
  lookup: LookupFormat;
  /** Floyd–Steinberg error strength, 0 disables dithering. */
  dither: number;
  /**
   * Squared RGB distance under which a pixel counts as "unchanged", so it can be
   * left transparent and let the previous frame show through. 0 = exact matches
   * only (lossless between frames); larger values shrink the file further.
   */
  deltaThreshold: number;
  /** How many frames are sampled when deriving the shared palette. */
  paletteSampleFrames: number;
}

export const QUALITY_PROFILES: Record<QualityLevel, QualityProfile> = {
  low: {
    id: 'low',
    label: 'Low',
    blurb: 'Smallest file. Fewer colours, some banding.',
    maxColors: 48,
    lookup: 'rgb444',
    dither: 0,
    deltaThreshold: 100,
    paletteSampleFrames: 6,
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    blurb: 'Balanced size and detail. A good default.',
    maxColors: 96,
    lookup: 'rgb444',
    dither: 0.55,
    deltaThreshold: 36,
    paletteSampleFrames: 8,
  },
  high: {
    id: 'high',
    label: 'High',
    blurb: 'Richer colour and smoother gradients.',
    maxColors: 192,
    lookup: 'rgb565',
    dither: 0.85,
    deltaThreshold: 0,
    paletteSampleFrames: 12,
  },
  extra: {
    id: 'extra',
    label: 'Extra High',
    blurb: 'Maximum colour fidelity. Largest file.',
    maxColors: 255,
    lookup: 'rgb565',
    dither: 1,
    deltaThreshold: 0,
    paletteSampleFrames: 16,
  },
};

export const QUALITY_ORDER: QualityLevel[] = ['low', 'medium', 'high', 'extra'];

export const getQualityProfile = (level: QualityLevel): QualityProfile =>
  QUALITY_PROFILES[level] ?? QUALITY_PROFILES.medium;
