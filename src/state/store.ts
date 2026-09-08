import { create } from 'zustand';
import type {
  CanvasPreset,
  CanvasSettings,
  CensorEffect,
  CensorRegion,
  CensorShape,
  CropRect,
  Direction,
  ExportResult,
  FitMode,
  PhotoAsset,
  QualityLevel,
  SourceKind,
  Sticker,
  VideoAsset,
  VideoSettings,
} from './types';
import { loadPrefs, savePrefs } from './prefs';
import { decodePhotoFile } from '../media/images';
import { LARGE_VIDEO_BYTES, VideoFrameReader } from '../media/video';
import {
  PhotoFrameProvider,
  SeekingVideoFrameProvider,
  VideoPreviewCache,
  planPreviewCache,
  type FrameProvider,
} from '../media/frames';
import { describeError } from '../media/errors';
import {
  MAX_FRAMES,
  buildPhotoPlan,
  buildVideoPlan,
  censorRectAt,
  mergeStaticFrames,
  type FramePlan,
} from '../render/timeline';
import { FULL_CROP, clamp, normaliseCrop, sanitiseDimension } from '../render/geometry';
import { getQualityProfile } from '../export/quality';
import {
  encodeGif,
  estimateGifSize,
  type EncodeProgress,
  type SizeEstimate,
} from '../export/encodeGif';
import { renderPaletteSamples, type RenderSettings } from '../export/renderPipeline';
import { uid } from '../lib/format';

export type Step = 'import' | 'edit' | 'export';
export type EditTool = 'timing' | 'stickers' | 'censor' | 'canvas';

export interface AppError {
  message: string;
  hint?: string;
}

interface Busy {
  label: string;
  progress?: number;
}

interface AppState {
  step: Step;
  tool: EditTool;
  kind: SourceKind | null;

  photos: PhotoAsset[];
  video: VideoAsset | null;
  reader: VideoFrameReader | null;
  previewCache: VideoPreviewCache | null;
  /** Trim window the current preview cache was built for. */
  cachedRange: { start: number; end: number } | null;

  canvas: CanvasSettings;
  crop: CropRect;
  videoSettings: VideoSettings;
  fps: number;

  /**
   * Source timestamp being scrubbed to while a trim grip is dragged. The
   * preview shows this exact frame, decoded from the video rather than from the
   * frame cache, so you can see precisely where a trim lands.
   */
  trimScrub: number | null;
  /**
   * The trim moved but the preview frame cache has not been rebuilt yet.
   * Rebuilding is deferred until playback actually needs it — rebuilding on
   * every trim adjustment makes fine-tuning impossible.
   */
  cacheStale: boolean;
  /** Preview fills the screen, hiding all editing chrome. */
  immersive: boolean;

  stickers: Sticker[];
  censors: CensorRegion[];
  selectedOverlayId: string | null;

  quality: QualityLevel;
  estimate: SizeEstimate | null;
  estimating: boolean;
  exporting: boolean;
  progress: EncodeProgress | null;
  result: ExportResult | null;

  busy: Busy | null;
  error: AppError | null;

  // ----------------------------------------------------------------- actions
  setStep: (step: Step) => void;
  setTool: (tool: EditTool) => void;
  setError: (error: AppError | null) => void;

  importPhotos: (files: File[]) => Promise<void>;
  importVideo: (file: File) => Promise<void>;
  reset: () => void;

  reorderPhotos: (from: number, to: number) => void;
  removePhoto: (id: string) => void;
  duplicatePhoto: (id: string) => void;
  setPhotoDuration: (id: string, durationMs: number) => void;
  setAllPhotoDurations: (durationMs: number) => void;

  setCanvasPreset: (preset: CanvasPreset) => void;
  setCanvasSize: (width: number, height: number, driver?: 'width' | 'height') => void;
  setLockAspect: (locked: boolean) => void;
  setFitMode: (mode: FitMode) => void;
  setBackground: (color: string) => void;
  setCrop: (crop: CropRect) => void;
  resetCrop: () => void;

  setTrim: (start: number, end: number) => void;
  setTrimScrub: (time: number | null) => void;
  setImmersive: (immersive: boolean) => void;
  setDirection: (direction: Direction) => void;
  setSpeed: (speed: number) => void;
  setFps: (fps: number) => void;

  addSticker: (emoji: string) => void;
  updateSticker: (id: string, patch: Partial<Sticker>) => void;
  removeSticker: (id: string) => void;

  addCensor: (effect: CensorEffect, shape: CensorShape) => void;
  updateCensor: (id: string, patch: Partial<Omit<CensorRegion, 'keyframes'>>) => void;
  removeCensor: (id: string) => void;
  setCensorRect: (id: string, timeMs: number, rect: { x: number; y: number; w: number; h: number }) => void;
  addCensorKeyframe: (id: string, timeMs: number) => void;
  removeCensorKeyframe: (id: string, t: number) => void;
  selectOverlay: (id: string | null) => void;

  setQuality: (quality: QualityLevel) => void;
  ensurePreviewCache: () => Promise<void>;
  runEstimate: () => Promise<void>;
  generate: () => Promise<void>;
  cancelExport: () => void;
  clearResult: () => void;
}

const prefs = loadPrefs();

const initialCanvas = (): CanvasSettings => ({
  preset: prefs.canvasPreset,
  width: prefs.width,
  height: prefs.height,
  lockAspect: true,
  fitMode: prefs.fitMode,
  background: prefs.background,
});

/**
 * Per-clip edits, as they should look for a brand-new project. Preferences
 * (output size, frame rate, quality) deliberately survive; edits do not.
 */
const freshEdits = () => ({
  crop: { ...FULL_CROP },
  stickers: [] as Sticker[],
  censors: [] as CensorRegion[],
  selectedOverlayId: null,
  videoSettings: { trimStart: 0, trimEnd: 0, direction: 'forward' as const, speed: 1 },
  trimScrub: null,
  cacheStale: false,
  result: null,
  estimate: null,
  tool: 'timing' as EditTool,
});

const initialVideoSettings = (): VideoSettings => ({
  trimStart: 0,
  trimEnd: 0,
  direction: 'forward',
  speed: 1,
});

/** Output size implied by a preset, given the source's own dimensions. */
function presetDimensions(
  preset: CanvasPreset,
  srcW: number,
  srcH: number,
  current: { width: number; height: number },
): { width: number; height: number } {
  // Cap the long edge: GIF is uncompressed-per-frame, so pixels are expensive.
  const cap = 720;
  const scale = Math.min(1, cap / Math.max(1, Math.max(srcW, srcH)));
  switch (preset) {
    case 'original':
      return {
        width: sanitiseDimension(srcW * scale),
        height: sanitiseDimension(srcH * scale),
      };
    case 'square': {
      const side = sanitiseDimension(Math.min(cap, Math.max(srcW, srcH) * scale));
      return { width: side, height: side };
    }
    case 'portrait': {
      const height = sanitiseDimension(Math.min(cap, Math.max(srcW, srcH) * scale));
      return { width: sanitiseDimension((height * 4) / 5), height };
    }
    case 'landscape': {
      const width = sanitiseDimension(Math.min(cap, Math.max(srcW, srcH) * scale));
      return { width, height: sanitiseDimension((width * 9) / 16) };
    }
    default:
      return current;
  }
}

interface SourceDims {
  width: number;
  height: number;
}

function sourceDimensions(state: Pick<AppState, 'kind' | 'photos' | 'video'>): SourceDims {
  if (state.kind === 'video' && state.video) {
    return { width: state.video.width, height: state.video.height };
  }
  const first = state.photos[0];
  if (first) return { width: first.width, height: first.height };
  return { width: 480, height: 480 };
}

/**
 * Builds the frame plan for the current project.
 *
 * Kept as a pure selector so the preview, the export and the tests all derive
 * their timeline from exactly the same code.
 */
export function selectPlan(state: AppState): FramePlan {
  const base =
    state.kind === 'video' && state.video
      ? buildVideoPlan({
          trimStart: state.videoSettings.trimStart,
          trimEnd: state.videoSettings.trimEnd,
          fps: state.fps,
          speed: state.videoSettings.speed,
          direction: state.videoSettings.direction,
        })
      : buildPhotoPlan(
          state.photos.map((photo) => photo.durationMs),
          state.fps,
        );
  return mergeStaticFrames(base, state.stickers, state.censors);
}

export function selectRenderSettings(state: AppState): RenderSettings {
  return {
    width: state.canvas.width,
    height: state.canvas.height,
    fitMode: state.canvas.fitMode,
    crop: state.crop,
    background: state.canvas.background,
    stickers: state.stickers,
    censors: state.censors,
  };
}

/** Frame source used by the live preview (cached low-res video frames). */
export function selectPreviewProvider(state: AppState): FrameProvider | null {
  if (state.kind === 'photos') return new PhotoFrameProvider(state.photos);
  return state.previewCache;
}

export const useStore = create<AppState>()((set, get) => {
  /** Lets the user stop a long export; recreated for each run. */
  let exportAbort: AbortController | null = null;

  /** Re-fits the crop rect whenever the source or the output aspect changes. */
  const refitCrop = (): void => {
    const state = get();
    const dims = sourceDimensions(state);
    set({
      crop: normaliseCrop(state.crop, dims.width, dims.height, state.canvas.width, state.canvas.height),
    });
  };

  const clearMedia = (): void => {
    const state = get();
    for (const photo of state.photos) {
      photo.image.close();
      URL.revokeObjectURL(photo.thumbUrl);
    }
    state.previewCache?.dispose();
    // The reader owns the video's object URL and revokes it on dispose.
    state.reader?.dispose();
    if (state.result) URL.revokeObjectURL(state.result.url);
  };

  return {
    step: 'import',
    tool: 'timing',
    kind: null,
    photos: [],
    video: null,
    reader: null,
    previewCache: null,
    cachedRange: null,
    canvas: initialCanvas(),
    crop: { ...FULL_CROP },
    videoSettings: initialVideoSettings(),
    fps: prefs.fps,
    trimScrub: null,
    cacheStale: false,
    immersive: false,
    stickers: [],
    censors: [],
    selectedOverlayId: null,
    quality: prefs.quality,
    estimate: null,
    estimating: false,
    exporting: false,
    progress: null,
    result: null,
    busy: null,
    error: null,

    setStep: (step) => set({ step }),
    setTool: (tool) => set({ tool }),
    setError: (error) => set({ error }),

    // ---------------------------------------------------------------- import

    importPhotos: async (files) => {
      if (files.length === 0) return;
      set({ busy: { label: 'Reading photos…', progress: 0 }, error: null });

      const wasPhotos = get().kind === 'photos';
      const existing = wasPhotos ? get().photos : [];
      const defaultDuration = loadPrefs().photoDurationMs;

      const added: PhotoAsset[] = [];
      const failures: string[] = [];
      try {
        for (let i = 0; i < files.length; i++) {
          set({
            busy: { label: `Reading photo ${i + 1} of ${files.length}…`, progress: i / files.length },
          });
          try {
            const decoded = await decodePhotoFile(files[i]);
            added.push({
              id: uid(),
              name: files[i].name,
              width: decoded.width,
              height: decoded.height,
              durationMs: defaultDuration,
              image: decoded.image,
              thumbUrl: decoded.thumbUrl,
            });
          } catch (error) {
            failures.push(describeError(error).message);
          }
        }

        if (added.length === 0) {
          // Nothing decoded: leave the existing project untouched.
          set({
            busy: null,
            error: {
              message: failures[0] ?? 'None of those files could be opened.',
              hint: failures.length > 1 ? `${failures.length} files failed.` : undefined,
            },
          });
          return;
        }

        // Only now is it safe to release a previously imported video.
        if (!wasPhotos) clearMedia();

        const photos = [...existing, ...added];
        const canvas = get().canvas;
        const size =
          existing.length > 0
            ? { width: canvas.width, height: canvas.height }
            : presetDimensions(canvas.preset, photos[0].width, photos[0].height, canvas);

        set({
          // Appending to an existing project keeps its edits; starting a new
          // one discards them, so a previous GIF never bleeds into the next.
          ...(existing.length > 0 ? { result: null, estimate: null } : freshEdits()),
          kind: 'photos',
          photos,
          video: null,
          reader: null,
          previewCache: null,
          cachedRange: null,
          canvas: { ...canvas, ...size },
          step: 'edit',
          busy: null,
          error:
            failures.length > 0
              ? {
                  message: `${failures.length} file${failures.length > 1 ? 's' : ''} could not be opened.`,
                  hint: failures[0],
                }
              : null,
        });
        refitCrop();
      } catch (error) {
        set({ busy: null, error: describeError(error) });
      }
    },

    importVideo: async (file) => {
      set({ busy: { label: 'Opening video…' }, error: null });
      clearMedia();
      set({
        photos: [],
        video: null,
        reader: null,
        previewCache: null,
        cachedRange: null,
        result: null,
        estimate: null,
      });
      try {
        const reader = await VideoFrameReader.open(file);
        // Default to the first few seconds: a whole clip at GIF frame rates is
        // usually far larger than anyone wants.
        const trimEnd = Math.min(reader.duration, 5);
        const canvas = get().canvas;
        const size = presetDimensions(canvas.preset, reader.width, reader.height, canvas);

        set({
          ...freshEdits(),
          kind: 'video',
          video: {
            id: uid(),
            name: file.name,
            width: reader.width,
            height: reader.height,
            duration: reader.duration,
            type: file.type,
            sizeBytes: file.size,
          },
          reader,
          canvas: { ...canvas, ...size },
          videoSettings: { trimStart: 0, trimEnd, direction: 'forward', speed: 1 },
          step: 'edit',
          busy: null,
          error:
            file.size > LARGE_VIDEO_BYTES
              ? {
                  message: 'That is a large video.',
                  hint: 'Keep the trimmed range short — long selections at high frame rates can run out of memory.',
                }
              : null,
        });
        refitCrop();
        await get().ensurePreviewCache();
      } catch (error) {
        set({ busy: null, error: describeError(error) });
      }
    },

    reset: () => {
      clearMedia();
      const fresh = loadPrefs();
      set({
        step: 'import',
        kind: null,
        photos: [],
        video: null,
        reader: null,
        previewCache: null,
        cachedRange: null,
        canvas: {
          preset: fresh.canvasPreset,
          width: fresh.width,
          height: fresh.height,
          lockAspect: true,
          fitMode: fresh.fitMode,
          background: fresh.background,
        },
        ...freshEdits(),
        fps: fresh.fps,
        quality: fresh.quality,
        estimating: false,
        exporting: false,
        progress: null,
        immersive: false,
        busy: null,
        error: null,
      });
    },

    // ---------------------------------------------------------------- photos

    reorderPhotos: (from, to) => {
      const photos = [...get().photos];
      if (from < 0 || from >= photos.length || to < 0 || to >= photos.length) return;
      const [moved] = photos.splice(from, 1);
      photos.splice(to, 0, moved);
      set({ photos, result: null, estimate: null });
    },

    removePhoto: (id) => {
      const photos = get().photos;
      const target = photos.find((photo) => photo.id === id);
      if (!target) return;
      // Only release the bitmap if no duplicate still references it.
      const shares = photos.filter((photo) => photo.image === target.image).length;
      if (shares === 1) {
        target.image.close();
        URL.revokeObjectURL(target.thumbUrl);
      }
      const next = photos.filter((photo) => photo.id !== id);
      set({ photos: next, result: null, estimate: null });
      if (next.length === 0) get().reset();
    },

    duplicatePhoto: (id) => {
      const photos = get().photos;
      const index = photos.findIndex((photo) => photo.id === id);
      if (index < 0) return;
      const source = photos[index];
      // Duplicates share the decoded bitmap and thumbnail: copying a 12MP
      // bitmap per duplicate would be pure waste.
      const copy: PhotoAsset = { ...source, id: uid() };
      const next = [...photos];
      next.splice(index + 1, 0, copy);
      set({ photos: next, result: null, estimate: null });
    },

    setPhotoDuration: (id, durationMs) => {
      const ms = Math.round(clamp(durationMs, 20, 10_000));
      set({
        photos: get().photos.map((photo) => (photo.id === id ? { ...photo, durationMs: ms } : photo)),
        result: null,
        estimate: null,
      });
    },

    setAllPhotoDurations: (durationMs) => {
      const ms = Math.round(clamp(durationMs, 20, 10_000));
      savePrefs({ photoDurationMs: ms });
      set({
        photos: get().photos.map((photo) => ({ ...photo, durationMs: ms })),
        result: null,
        estimate: null,
      });
    },

    // ---------------------------------------------------------------- canvas

    setCanvasPreset: (preset) => {
      const state = get();
      const dims = sourceDimensions(state);
      const size = presetDimensions(preset, dims.width, dims.height, state.canvas);
      savePrefs({ canvasPreset: preset, width: size.width, height: size.height });
      set({ canvas: { ...state.canvas, preset, ...size }, result: null, estimate: null });
      refitCrop();
    },

    setCanvasSize: (width, height, driver = 'width') => {
      const state = get();
      const previous = state.canvas;
      let nextWidth = sanitiseDimension(width);
      let nextHeight = sanitiseDimension(height);
      if (previous.lockAspect) {
        const aspect = previous.width / previous.height;
        if (driver === 'width') nextHeight = sanitiseDimension(nextWidth / aspect);
        else nextWidth = sanitiseDimension(nextHeight * aspect);
      }
      savePrefs({ canvasPreset: 'custom', width: nextWidth, height: nextHeight });
      set({
        canvas: { ...previous, preset: 'custom', width: nextWidth, height: nextHeight },
        result: null,
        estimate: null,
      });
      refitCrop();
    },

    setLockAspect: (locked) => set({ canvas: { ...get().canvas, lockAspect: locked } }),

    setFitMode: (mode) => {
      savePrefs({ fitMode: mode });
      set({ canvas: { ...get().canvas, fitMode: mode }, result: null, estimate: null });
      refitCrop();
    },

    setBackground: (color) => {
      savePrefs({ background: color });
      set({ canvas: { ...get().canvas, background: color }, result: null, estimate: null });
    },

    setCrop: (crop) => {
      const state = get();
      const dims = sourceDimensions(state);
      set({
        crop: normaliseCrop(crop, dims.width, dims.height, state.canvas.width, state.canvas.height),
        result: null,
        estimate: null,
      });
    },

    resetCrop: () => {
      set({ crop: { ...FULL_CROP } });
      refitCrop();
    },

    // -------------------------------------------------------------- playback

    setTrim: (start, end) => {
      const state = get();
      if (!state.video) return;
      const duration = state.video.duration;
      const nextStart = clamp(start, 0, Math.max(0, duration - 0.05));
      const nextEnd = clamp(end, nextStart + 0.05, duration);
      const cached = state.cachedRange;
      const matchesCache =
        cached !== null &&
        Math.abs(cached.start - nextStart) < 0.02 &&
        Math.abs(cached.end - nextEnd) < 0.02;
      set({
        videoSettings: { ...state.videoSettings, trimStart: nextStart, trimEnd: nextEnd },
        // Defer the rebuild: it happens when playback next needs it.
        cacheStale: !matchesCache,
        result: null,
        estimate: null,
      });
    },

    setTrimScrub: (time) => set({ trimScrub: time }),

    setImmersive: (immersive) => set({ immersive }),

    setDirection: (direction) =>
      set({ videoSettings: { ...get().videoSettings, direction }, result: null, estimate: null }),

    setSpeed: (speed) =>
      set({ videoSettings: { ...get().videoSettings, speed }, result: null, estimate: null }),

    setFps: (fps) => {
      savePrefs({ fps });
      set({ fps, result: null, estimate: null });
    },

    // -------------------------------------------------------------- overlays

    addSticker: (emoji) => {
      const sticker: Sticker = {
        id: uid(),
        emoji,
        x: 0.5,
        y: 0.5,
        size: 0.28,
        rotation: 0,
        range: null,
      };
      set({
        stickers: [...get().stickers, sticker],
        selectedOverlayId: sticker.id,
        result: null,
        estimate: null,
      });
    },

    updateSticker: (id, patch) =>
      set({
        stickers: get().stickers.map((sticker) =>
          sticker.id === id ? { ...sticker, ...patch } : sticker,
        ),
        result: null,
        estimate: null,
      }),

    removeSticker: (id) =>
      set({
        stickers: get().stickers.filter((sticker) => sticker.id !== id),
        selectedOverlayId: get().selectedOverlayId === id ? null : get().selectedOverlayId,
        result: null,
        estimate: null,
      }),

    addCensor: (effect, shape) => {
      const region: CensorRegion = {
        id: uid(),
        shape,
        effect,
        strength: 0.6,
        range: null,
        keyframes: [{ t: 0, x: 0.5, y: 0.45, w: 0.34, h: 0.34 }],
      };
      set({
        censors: [...get().censors, region],
        selectedOverlayId: region.id,
        result: null,
        estimate: null,
      });
    },

    updateCensor: (id, patch) =>
      set({
        censors: get().censors.map((region) => (region.id === id ? { ...region, ...patch } : region)),
        result: null,
        estimate: null,
      }),

    removeCensor: (id) =>
      set({
        censors: get().censors.filter((region) => region.id !== id),
        selectedOverlayId: get().selectedOverlayId === id ? null : get().selectedOverlayId,
        result: null,
        estimate: null,
      }),

    /**
     * Moves/resizes a region. With one keyframe the region stays static and the
     * single keyframe is updated in place; with several, the keyframe nearest
     * the current time is updated so dragging edits the point you are looking at.
     */
    setCensorRect: (id, timeMs, rect) =>
      set({
        censors: get().censors.map((region) => {
          if (region.id !== id) return region;
          const keys = [...region.keyframes];
          if (keys.length <= 1) {
            return { ...region, keyframes: [{ t: keys[0]?.t ?? 0, ...rect }] };
          }
          let nearest = 0;
          for (let i = 1; i < keys.length; i++) {
            if (Math.abs(keys[i].t - timeMs) < Math.abs(keys[nearest].t - timeMs)) nearest = i;
          }
          keys[nearest] = { ...keys[nearest], ...rect };
          return { ...region, keyframes: keys };
        }),
        result: null,
        estimate: null,
      }),

    addCensorKeyframe: (id, timeMs) =>
      set({
        censors: get().censors.map((region) => {
          if (region.id !== id) return region;
          const t = Math.max(0, Math.round(timeMs));
          const existing = region.keyframes.find((key) => Math.abs(key.t - t) < 1);
          if (existing) return region;
          // Seed the new keyframe with the interpolated position at that time,
          // so adding one never makes the region jump.
          const here = censorRectAt(region, t);
          const keys = [...region.keyframes, { t, ...here }].sort((a, b) => a.t - b.t);
          return { ...region, keyframes: keys };
        }),
        result: null,
        estimate: null,
      }),

    removeCensorKeyframe: (id, t) =>
      set({
        censors: get().censors.map((region) => {
          if (region.id !== id || region.keyframes.length <= 1) return region;
          return { ...region, keyframes: region.keyframes.filter((key) => key.t !== t) };
        }),
        result: null,
        estimate: null,
      }),

    selectOverlay: (id) => set({ selectedOverlayId: id }),

    // ---------------------------------------------------------------- export

    setQuality: (quality) => {
      savePrefs({ quality });
      set({ quality, estimate: null });
    },

    ensurePreviewCache: async () => {
      const state = get();
      if (state.kind !== 'video' || !state.reader) return;
      const { trimStart, trimEnd } = state.videoSettings;
      const cached = state.cachedRange;
      if (cached && Math.abs(cached.start - trimStart) < 0.02 && Math.abs(cached.end - trimEnd) < 0.02) {
        set({ cacheStale: false });
        return;
      }

      const plan = planPreviewCache(trimStart, trimEnd, state.reader.width, state.reader.height);
      set({ busy: { label: 'Preparing preview…', progress: 0 } });
      try {
        const cache = await VideoPreviewCache.build(state.reader, plan, {
          onProgress: (done, total) =>
            set({ busy: { label: 'Preparing preview…', progress: done / total } }),
        });
        get().previewCache?.dispose();
        set({
          previewCache: cache,
          cachedRange: { start: trimStart, end: trimEnd },
          cacheStale: false,
          trimScrub: null,
          busy: null,
        });
      } catch (error) {
        set({ busy: null, error: describeError(error) });
      }
    },

    runEstimate: async () => {
      const state = get();
      const plan = selectPlan(state);
      // Prefer the cached preview frames; fall back to seeking the real source
      // so a missing cache degrades to "slower", not "unavailable".
      const provider =
        selectPreviewProvider(state) ??
        (state.reader ? new SeekingVideoFrameProvider(state.reader) : null);
      if (!provider || plan.frames.length === 0) return;
      set({ estimating: true });
      try {
        const settings = selectRenderSettings(state);
        const profile = getQualityProfile(state.quality);
        const samples = await renderPaletteSamples(plan, provider, settings, profile.paletteSampleFrames);
        const estimate = await estimateGifSize({
          plan,
          provider,
          settings,
          profile,
          paletteSamples: samples,
        });
        set({ estimate, estimating: false });
      } catch (error) {
        set({ estimating: false, error: describeError(error) });
      }
    },

    generate: async () => {
      const state = get();
      const plan = selectPlan(state);
      if (plan.frames.length === 0) {
        set({ error: { message: 'There is nothing to export yet.', hint: 'Import a photo or video first.' } });
        return;
      }
      if (plan.frames.length >= MAX_FRAMES) {
        set({
          error: {
            message: `This GIF would need more than ${MAX_FRAMES} frames.`,
            hint: 'Shorten the clip, lower the frame rate, or speed it up.',
          },
        });
        return;
      }

      const settings = selectRenderSettings(state);
      const profile = getQualityProfile(state.quality);
      const previewProvider = selectPreviewProvider(state);

      // Full-resolution frames come from the source; the palette is sampled from
      // the cheap preview provider so it costs no extra video seeks.
      const exportProvider: FrameProvider | null =
        state.kind === 'video'
          ? state.reader
            ? new SeekingVideoFrameProvider(state.reader)
            : null
          : new PhotoFrameProvider(state.photos);

      if (!exportProvider) {
        set({
          error: {
            message: 'The media for this project is no longer available.',
            hint: 'Import it again.',
          },
        });
        return;
      }

      // Palette samples normally come from the cheap cached preview frames. If
      // that cache is missing (a failed or skipped build) fall back to the real
      // source rather than refusing to export.
      const paletteProvider = previewProvider ?? exportProvider;

      if (state.result) URL.revokeObjectURL(state.result.url);
      exportAbort?.abort();
      const controller = new AbortController();
      exportAbort = controller;
      set({
        exporting: true,
        result: null,
        error: null,
        progress: { phase: 'preparing', done: 0, total: plan.frames.length },
      });

      try {
        const samples = await renderPaletteSamples(
          plan,
          paletteProvider,
          settings,
          profile.paletteSampleFrames,
        );
        const output = await encodeGif({
          plan,
          provider: exportProvider,
          settings,
          profile,
          paletteSamples: samples,
          signal: controller.signal,
          onProgress: (progress) => set({ progress }),
        });

        const blob = new Blob([output.bytes as unknown as BlobPart], { type: 'image/gif' });
        set({
          exporting: false,
          progress: null,
          result: {
            blob,
            url: URL.createObjectURL(blob),
            bytes: blob.size,
            width: settings.width,
            height: settings.height,
            fps: plan.fps,
            durationMs: plan.durationMs,
            frameCount: output.frames,
            quality: state.quality,
          },
        });
      } catch (error) {
        const described = describeError(error);
        set({
          exporting: false,
          progress: null,
          error:
            described.message === 'Cancelled.'
              ? null
              : { message: `The GIF could not be created. ${described.message}`, hint: described.hint },
        });
      } finally {
        if (exportAbort === controller) exportAbort = null;
      }
    },

    cancelExport: () => {
      exportAbort?.abort();
      exportAbort = null;
      set({ exporting: false, progress: null });
    },

    clearResult: () => {
      const result = get().result;
      if (result) URL.revokeObjectURL(result.url);
      set({ result: null });
    },
  };
});
