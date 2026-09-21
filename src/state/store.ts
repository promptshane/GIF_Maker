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
  ProjectMode,
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
  retimeCensorForSpeed,
  type FramePlan,
} from '../render/timeline';
import {
  FULL_CROP,
  clamp,
  fitLockedDimensions,
  normaliseCrop,
  refitCrop,
  sanitiseDimension,
} from '../render/geometry';
import { getQualityProfile } from '../export/quality';
import {
  encodeGif,
  estimateGifSize,
  type EncodeProgress,
  type SizeEstimate,
} from '../export/encodeGif';
import { FrameRenderer, renderPaletteSamples, type RenderSettings } from '../export/renderPipeline';
import { uid } from '../lib/format';
import {
  defaultProjectName,
  duplicateProjectRecords,
  editsSnapshot,
  projectBytes,
  toFiles,
  toProjectData,
  type ProjectEdits,
  type SavedProjectMeta,
} from './projects';
import {
  deleteProject as deleteStoredProject,
  getProject,
  getProjectMeta,
  isEphemeralStorageError,
  isQuotaError,
  projectsSupported,
  putProject,
  requestPersistence,
} from './projectsDb';

export type Step = 'import' | 'edit' | 'export';
export type EditTool = 'timing' | 'stickers' | 'censor' | 'canvas' | 'quality';

export interface AppError {
  message: string;
  hint?: string;
}

interface Busy {
  label: string;
  progress?: number;
}

interface AppState {
  /** null is the first-run chooser; otherwise it selects the GIF or photo workspace. */
  appMode: ProjectMode | null;
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
  /** 1..100; controls both JPEG compression and exported still-image resolution. */
  photoQuality: number;
  estimate: SizeEstimate | null;
  estimating: boolean;
  exporting: boolean;
  progress: EncodeProgress | null;
  result: ExportResult | null;

  busy: Busy | null;
  error: AppError | null;

  /** Whether this browser can keep projects on the device at all. */
  projectsSupported: boolean;
  /** Identity of the saved project this editor session belongs to, if any. */
  projectId: string | null;
  projectName: string | null;
  /** `editsSnapshot` as of the last save; compared live to detect unsaved changes. */
  savedSnapshot: string | null;

  // ----------------------------------------------------------------- actions
  setStep: (step: Step) => void;
  setAppMode: (mode: ProjectMode) => void;
  goHome: () => void;
  setTool: (tool: EditTool) => void;
  setError: (error: AppError | null) => void;

  importPhotos: (files: File[]) => Promise<void>;
  importPhoto: (file: File) => Promise<void>;
  importVideo: (file: File) => Promise<void>;
  reset: () => void;

  /** Writes the current project to on-device storage under `name`. Resolves true on success. */
  saveProject: (name: string) => Promise<boolean>;
  /** Reopens a saved project in an editable state. */
  openProject: (id: string) => Promise<void>;
  /** Makes a separately saved copy that can be edited without changing the original. */
  duplicateProject: (id: string) => Promise<boolean>;
  deleteProject: (id: string) => Promise<void>;

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
  duplicateCensor: (id: string, timeMs: number) => void;
  updateCensor: (id: string, patch: Partial<Omit<CensorRegion, 'keyframes'>>) => void;
  removeCensor: (id: string) => void;
  setCensorRect: (id: string, timeMs: number, rect: { x: number; y: number; w: number; h: number }) => void;
  addCensorKeyframe: (id: string, timeMs: number) => void;
  removeCensorKeyframe: (id: string, t: number) => void;
  selectOverlay: (id: string | null) => void;

  setQuality: (quality: QualityLevel) => void;
  setPhotoQuality: (quality: number) => void;
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
const freshEdits = (mode: ProjectMode = 'gif') => ({
  crop: { ...FULL_CROP },
  stickers: [] as Sticker[],
  censors: [] as CensorRegion[],
  selectedOverlayId: null,
  videoSettings: { trimStart: 0, trimEnd: 0, direction: 'forward' as const, speed: 1 },
  trimScrub: null,
  cacheStale: false,
  result: null,
  estimate: null,
  photoQuality: 100,
  tool: (mode === 'photo' ? 'censor' : 'timing') as EditTool,
  // A new import is a new project, not a change to the one that was open.
  projectId: null,
  projectName: null,
  savedSnapshot: null,
});

/** Edits restored from a saved project, applied on top of `freshEdits`. */
const restoredEdits = (edits: ProjectEdits) => ({
  canvas: { ...edits.canvas },
  crop: { ...edits.crop },
  videoSettings: { ...edits.videoSettings },
  fps: edits.fps,
  quality: edits.quality,
  photoQuality: edits.photoQuality ?? 100,
  stickers: edits.stickers,
  censors: edits.censors,
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

/**
 * Pixel size of the source the crop rectangle is framed against: the video, or
 * the first photo. Exported so the crop editor normalises against the same
 * dimensions the store does.
 */
export function sourceDimensions(state: Pick<AppState, 'kind' | 'photos' | 'video'>): SourceDims {
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

  /**
   * Re-fits the crop rect whenever the source or the output aspect changes.
   * Uses the cover-style refit, not `normaliseCrop`: the latter treats width
   * as authoritative and so could only ever shrink the crop, which is what
   * made repeated framing changes zoom further and further in.
   */
  const refitCropToOutput = (): void => {
    const state = get();
    const dims = sourceDimensions(state);
    set({
      crop: refitCrop(state.crop, dims.width, dims.height, state.canvas.width, state.canvas.height),
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

  interface PhotoInput {
    file: File;
    durationMs: number;
  }

  /**
   * Decodes photos into the project. Shared by a fresh import, "+ Add" on an
   * existing project, and reopening a saved one — which passes the saved
   * edits to restore instead of starting from `freshEdits`.
   */
  const loadPhotos = async (
    inputs: PhotoInput[],
    {
      append,
      restore = null,
      mode = get().appMode ?? 'gif',
    }: { append: boolean; restore?: ProjectEdits | null; mode?: ProjectMode },
  ): Promise<void> => {
    if (inputs.length === 0) return;
    set({ busy: { label: 'Reading photos…', progress: 0 }, error: null });

    const existing = append ? get().photos : [];
    const added: PhotoAsset[] = [];
    const failures: string[] = [];
    // A saved project stores each distinct file once; decode it once too.
    const decodedByFile = new Map<File, PhotoAsset>();
    try {
      for (let i = 0; i < inputs.length; i++) {
        set({
          busy: { label: `Reading photo ${i + 1} of ${inputs.length}…`, progress: i / inputs.length },
        });
        const input = inputs[i];
        const twin = decodedByFile.get(input.file);
        if (twin) {
          added.push({ ...twin, id: uid(), durationMs: input.durationMs });
          continue;
        }
        try {
          const decoded = await decodePhotoFile(input.file);
          const asset: PhotoAsset = {
            id: uid(),
            name: input.file.name,
            width: decoded.width,
            height: decoded.height,
            durationMs: input.durationMs,
            image: decoded.image,
            thumbUrl: decoded.thumbUrl,
            file: input.file,
          };
          decodedByFile.set(input.file, asset);
          added.push(asset);
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
      if (!append) clearMedia();

      const photos = [...existing, ...added];
      const canvas = get().canvas;
      const size =
        existing.length > 0
          ? { width: canvas.width, height: canvas.height }
          : presetDimensions(canvas.preset, photos[0].width, photos[0].height, canvas);

      set({
        // Appending to an existing project keeps its edits; starting a new
        // one discards them, so a previous GIF never bleeds into the next.
        ...(append ? { result: null, estimate: null } : freshEdits(mode)),
        ...(restore ? restoredEdits(restore) : {}),
        kind: 'photos',
        appMode: mode,
        photos,
        video: null,
        reader: null,
        previewCache: null,
        cachedRange: null,
        ...(restore ? {} : { canvas: { ...canvas, ...size } }),
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
      // A restored crop was normalised when it was saved; a new one must be.
      if (!restore) refitCropToOutput();
    } catch (error) {
      set({ busy: null, error: describeError(error) });
    }
  };

  /** Opens a video as the project, restoring saved edits when given. */
  const loadVideo = async (file: File, restore: ProjectEdits | null): Promise<void> => {
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
        ...freshEdits('gif'),
        ...(restore ? restoredEdits(restore) : {}),
        kind: 'video',
        appMode: 'gif',
        video: {
          id: uid(),
          name: file.name,
          width: reader.width,
          height: reader.height,
          duration: reader.duration,
          type: file.type,
          sizeBytes: file.size,
          file,
        },
        reader,
        ...(restore
          ? {}
          : {
              canvas: { ...canvas, ...size },
              videoSettings: { trimStart: 0, trimEnd, direction: 'forward', speed: 1 },
            }),
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
      if (!restore) refitCropToOutput();
      await get().ensurePreviewCache();
    } catch (error) {
      set({ busy: null, error: describeError(error) });
    }
  };

  /**
   * A small JPEG of the first frame with the edits applied, for the saved
   * projects list. Best effort: a project with no renderable frame (a video
   * whose preview cache is missing) simply has no picture.
   */
  const renderThumbnail = async (state: AppState): Promise<Blob | null> => {
    try {
      const plan = selectPlan(state);
      const provider = selectPreviewProvider(state);
      const first = plan.frames[0];
      if (!provider || !first) return null;
      const settings = selectRenderSettings(state);
      const scale = Math.min(1, 160 / Math.max(settings.width, settings.height));
      const renderer = new FrameRenderer(settings.width * scale, settings.height * scale);
      try {
        const pixels = await renderer.render(provider, first.source, first.timeMs, settings);
        const canvas = document.createElement('canvas');
        canvas.width = pixels.width;
        canvas.height = pixels.height;
        canvas.getContext('2d')?.putImageData(pixels, 0, 0);
        return await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.75),
        );
      } finally {
        renderer.dispose();
      }
    } catch {
      return null;
    }
  };

  return {
    appMode: null,
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
    photoQuality: 100,
    estimate: null,
    estimating: false,
    exporting: false,
    progress: null,
    result: null,
    busy: null,
    error: null,
    projectsSupported: projectsSupported(),
    projectId: null,
    projectName: null,
    savedSnapshot: null,

    setStep: (step) => set({ step }),
    setAppMode: (appMode) => set({ appMode, step: 'import', tool: appMode === 'photo' ? 'censor' : 'timing' }),
    goHome: () => {
      clearMedia();
      set({
        appMode: null,
        step: 'import',
        kind: null,
        photos: [],
        video: null,
        reader: null,
        previewCache: null,
        cachedRange: null,
        ...freshEdits('gif'),
        busy: null,
        error: null,
        immersive: false,
      });
    },
    setTool: (tool) => set({ tool }),
    setError: (error) => set({ error }),

    // ---------------------------------------------------------------- import

    importPhotos: async (files) => {
      if (files.length === 0) return;
      const wasPhotos = get().kind === 'photos';
      const durationMs = loadPrefs().photoDurationMs;
      await loadPhotos(
        files.map((file) => ({ file, durationMs })),
        { append: wasPhotos, mode: 'gif' },
      );
    },

    importPhoto: async (file) => {
      const durationMs = loadPrefs().photoDurationMs;
      await loadPhotos([{ file, durationMs }], { append: false, mode: 'photo' });
    },

    importVideo: async (file) => {
      await loadVideo(file, null);
    },

    reset: () => {
      const mode = get().appMode ?? 'gif';
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
        ...freshEdits(mode),
        appMode: mode,
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

    // -------------------------------------------------------------- projects

    saveProject: async (name) => {
      const state = get();
      const trimmed = name.trim() || defaultProjectName(state);
      const id = state.projectId ?? uid();
      set({ busy: { label: 'Saving project…' }, error: null });
      try {
        const data = toProjectData(id, state);
        const meta: SavedProjectMeta = {
          id,
          name: trimmed,
          savedAt: Date.now(),
          kind: data.kind,
          mode: state.appMode ?? 'gif',
          thumb: await renderThumbnail(state),
          bytes: projectBytes(data),
          durationMs: selectPlan(state).durationMs,
          photoCount: state.photos.length,
        };
        await putProject(meta, data);
        // Ask only once something is worth keeping; the answer is advisory.
        void requestPersistence();
        set({
          projectId: id,
          projectName: trimmed,
          savedSnapshot: editsSnapshot(get()),
          busy: null,
        });
        return true;
      } catch (error) {
        set({
          busy: null,
          error: isQuotaError(error)
            ? {
                message: 'There is not enough storage to save this project.',
                hint: 'Delete an older project from the home screen, or free up space on this device.',
              }
            : isEphemeralStorageError(error)
              ? {
                  message: 'Projects cannot be saved in Private Browsing.',
                  hint: 'Open the app in a normal window, or from the Home Screen, to keep projects.',
                }
              : {
                  message: 'The project could not be saved.',
                  hint: describeError(error).message,
                },
        });
        return false;
      }
    },

    openProject: async (id) => {
      set({ busy: { label: 'Opening project…' }, error: null });
      let data;
      try {
        data = await getProject(id);
      } catch (error) {
        set({ busy: null, error: { message: 'The project could not be opened.', hint: describeError(error).message } });
        return;
      }
      if (!data) {
        set({ busy: null, error: { message: 'That project is no longer in storage.' } });
        return;
      }
      const files = toFiles(data);
      if (data.kind === 'video') {
        await loadVideo(files[0], data.edits);
      } else {
        await loadPhotos(
          data.photos.map((photo) => ({ file: files[photo.file], durationMs: photo.durationMs })),
          { append: false, restore: data.edits, mode: data.mode ?? 'gif' },
        );
      }
      // Only a project that actually opened is "the saved project".
      if (get().video || get().photos.length > 0) {
        const meta = await getProjectMeta(id).catch(() => null);
        set({ projectId: id, projectName: meta?.name ?? null, savedSnapshot: editsSnapshot(get()) });
      }
    },

    deleteProject: async (id) => {
      try {
        await deleteStoredProject(id);
        if (get().projectId === id) set({ projectId: null, projectName: null, savedSnapshot: null });
      } catch (error) {
        set({ error: { message: 'The project could not be deleted.', hint: describeError(error).message } });
      }
    },

    duplicateProject: async (id) => {
      set({ busy: { label: 'Duplicating project…' }, error: null });
      try {
        const [meta, data] = await Promise.all([getProjectMeta(id), getProject(id)]);
        if (!meta || !data) throw new Error('That project is no longer in storage.');

        const copyId = uid();
        const copy = duplicateProjectRecords(meta, data, copyId);
        await putProject(copy.meta, copy.data);
        void requestPersistence();
        set({ busy: null });
        return true;
      } catch (error) {
        set({
          busy: null,
          error: isQuotaError(error)
            ? {
                message: 'There is not enough storage to duplicate this project.',
                hint: 'Delete an older project from the home screen, or free up space on this device.',
              }
            : {
                message: 'The project could not be duplicated.',
                hint: describeError(error).message,
              },
        });
        return false;
      }
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
      refitCropToOutput();
    },

    setCanvasSize: (width, height, driver = 'width') => {
      const state = get();
      const previous = state.canvas;
      let nextWidth = sanitiseDimension(width);
      let nextHeight = sanitiseDimension(height);
      if (previous.lockAspect) {
        // Derive the other side from the raw value and clamp the *pair*, so a
        // value that hits the min/max cannot silently change the aspect ratio.
        const fitted = fitLockedDimensions(
          driver === 'width' ? width : height,
          driver,
          previous.width / previous.height,
        );
        nextWidth = fitted.width;
        nextHeight = fitted.height;
      }
      savePrefs({ canvasPreset: 'custom', width: nextWidth, height: nextHeight });
      set({
        canvas: { ...previous, preset: 'custom', width: nextWidth, height: nextHeight },
        result: null,
        estimate: null,
      });
      refitCropToOutput();
    },

    setLockAspect: (locked) => set({ canvas: { ...get().canvas, lockAspect: locked } }),

    setFitMode: (mode) => {
      savePrefs({ fitMode: mode });
      set({ canvas: { ...get().canvas, fitMode: mode }, result: null, estimate: null });
      refitCropToOutput();
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
      refitCropToOutput();
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

    setSpeed: (speed) => {
      const state = get();
      const nextSpeed = Math.max(0.01, speed);
      const oldSpeed = Math.max(0.01, state.videoSettings.speed);
      set({
        videoSettings: { ...state.videoSettings, speed: nextSpeed },
        // Tracking points are authored on the output timeline. Retime them so
        // they stay attached to the same source-video moments as speed changes.
        censors:
          state.kind === 'video'
            ? state.censors.map((region) => retimeCensorForSpeed(region, oldSpeed, nextSpeed))
            : state.censors,
        result: null,
        estimate: null,
      });
    },

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
        keyframes: [
          effect === 'black'
            ? { t: 0, x: 0.5, y: 0.45, w: 0.56, h: 0.12 }
            : { t: 0, x: 0.5, y: 0.45, w: 0.34, h: 0.34 },
        ],
      };
      set({
        censors: [...get().censors, region],
        selectedOverlayId: region.id,
        result: null,
        estimate: null,
      });
    },

    duplicateCensor: (id, timeMs) => {
      const source = get().censors.find((region) => region.id === id);
      if (!source) return;
      const here = censorRectAt(source, timeMs);
      const copy: CensorRegion = {
        ...source,
        id: uid(),
        range: source.range && { ...source.range },
        // A small offset makes the copy visible and preserves its exact size.
        keyframes: [{ t: 0, ...here, x: clamp(here.x + 0.04, 0, 1), y: clamp(here.y + 0.04, 0, 1) }],
      };
      set({
        censors: [...get().censors, copy],
        selectedOverlayId: copy.id,
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

    setPhotoQuality: (photoQuality) =>
      set({ photoQuality: Math.round(clamp(photoQuality, 1, 100)) }),

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
