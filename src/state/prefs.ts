import type { CanvasPreset, FitMode, QualityLevel } from './types';

const KEY = 'gifmaker.prefs.v1';

/**
 * Lightweight, non-sensitive preferences only.
 *
 * These are *settings* that should carry between projects (output size, frame
 * rate, quality). Anything that is an edit to a particular clip — trim,
 * direction, speed, crop, stickers, censor regions — deliberately lives outside
 * this, so every new import starts clean.
 *
 * Imported photos and videos are never persisted: they live in memory for the
 * session and are released when the project is cleared or the tab closes.
 */
export interface Prefs {
  fps: number;
  quality: QualityLevel;
  canvasPreset: CanvasPreset;
  width: number;
  height: number;
  fitMode: FitMode;
  background: string;
  photoDurationMs: number;
}

export const DEFAULT_PREFS: Prefs = {
  fps: 15,
  quality: 'medium',
  canvasPreset: 'original',
  width: 480,
  height: 480,
  fitMode: 'fill',
  background: '#000000',
  photoDurationMs: 600,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    // Private browsing and disabled storage both throw here; defaults are fine.
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Partial<Prefs>): void {
  try {
    const merged = { ...loadPrefs(), ...prefs };
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // Storage being unavailable must never break an export.
  }
}
