import type {
  CanvasSettings,
  CensorRegion,
  CropRect,
  PhotoAsset,
  QualityLevel,
  ProjectMode,
  SourceKind,
  Sticker,
  VideoSettings,
} from './types';

/**
 * Saved projects: what a project *is* on disk, and how it maps to and from
 * the store. Pure and free of IndexedDB so it can be unit tested; the
 * database itself lives in `projectsDb.ts`.
 *
 * A project is stored as two records — a small `meta` row for the list on the
 * home screen (name, date, thumbnail, size) and a `data` row carrying the
 * edits and the original media files. Media is stored as picked, not as
 * decoded pixels: a video file is far smaller than its frames, and reopening
 * simply runs the normal import path again.
 */

export const PROJECT_VERSION = 1;

/** Every per-clip edit, plus the output settings that shape the result. */
export interface ProjectEdits {
  canvas: CanvasSettings;
  crop: CropRect;
  videoSettings: VideoSettings;
  fps: number;
  quality: QualityLevel;
  /** JPEG quality/resolution slider used by still-photo projects. */
  photoQuality?: number;
  stickers: Sticker[];
  censors: CensorRegion[];
}

export interface SavedProjectMeta {
  id: string;
  name: string;
  /** Unix milliseconds. */
  savedAt: number;
  kind: SourceKind;
  /** Missing on projects saved before the photo editor existed; those are GIFs. */
  mode?: ProjectMode;
  /** Small JPEG of the first frame with edits applied; null if none could be rendered. */
  thumb: Blob | null;
  /** Total size of the stored media. */
  bytes: number;
  durationMs: number;
  photoCount: number;
}

export interface StoredFile {
  name: string;
  type: string;
  blob: Blob;
}

export interface SavedProjectData {
  id: string;
  version: number;
  kind: SourceKind;
  mode?: ProjectMode;
  /** Unique source files. Photos reference these by index so duplicates are stored once. */
  files: StoredFile[];
  photos: Array<{ file: number; durationMs: number }>;
  edits: ProjectEdits;
}

/** The slice of store state a project is built from. */
export interface ProjectSource extends ProjectEdits {
  appMode?: ProjectMode | null;
  kind: SourceKind | null;
  photos: PhotoAsset[];
  video: { name: string; type: string; file: Blob } | null;
}

/**
 * A stable fingerprint of everything a save would write, minus the media
 * bytes. The store compares it with the fingerprint taken at the last save to
 * know whether there are unsaved changes, so no edit action has to remember
 * to set a flag.
 */
export function editsSnapshot(state: ProjectSource): string {
  return JSON.stringify({
    kind: state.kind,
    photos: state.photos.map((photo) => [photo.id, photo.durationMs]),
    video: state.video?.name ?? null,
    canvas: state.canvas,
    crop: state.crop,
    videoSettings: state.videoSettings,
    fps: state.fps,
    quality: state.quality,
    ...(state.photoQuality !== undefined ? { photoQuality: state.photoQuality } : {}),
    stickers: state.stickers,
    censors: state.censors,
  });
}

export function pickEdits(state: ProjectEdits): ProjectEdits {
  return {
    canvas: { ...state.canvas },
    crop: { ...state.crop },
    videoSettings: { ...state.videoSettings },
    fps: state.fps,
    quality: state.quality,
    ...(state.photoQuality !== undefined ? { photoQuality: state.photoQuality } : {}),
    stickers: state.stickers.map((sticker) => ({ ...sticker, range: sticker.range && { ...sticker.range } })),
    censors: state.censors.map((region) => ({
      ...region,
      range: region.range && { ...region.range },
      keyframes: region.keyframes.map((key) => ({ ...key })),
    })),
  };
}

/** Builds the data record. Throws if there is no media to save. */
export function toProjectData(id: string, state: ProjectSource): SavedProjectData {
  if (state.kind === 'video' && state.video) {
    return {
      id,
      version: PROJECT_VERSION,
      kind: 'video',
      mode: state.appMode ?? 'gif',
      files: [{ name: state.video.name, type: state.video.type, blob: state.video.file }],
      photos: [],
      edits: pickEdits(state),
    };
  }
  if (state.kind === 'photos' && state.photos.length > 0) {
    // Duplicates share a Blob by reference; store each distinct one once.
    const files: StoredFile[] = [];
    const indexOf = new Map<Blob, number>();
    const photos = state.photos.map((photo) => {
      let index = indexOf.get(photo.file);
      if (index === undefined) {
        index = files.length;
        indexOf.set(photo.file, index);
        files.push({ name: photo.name, type: photo.file.type, blob: photo.file });
      }
      return { file: index, durationMs: photo.durationMs };
    });
    return {
      id,
      version: PROJECT_VERSION,
      kind: 'photos',
      mode: state.appMode ?? 'gif',
      files,
      photos,
      edits: pickEdits(state),
    };
  }
  throw new Error('There is nothing to save yet.');
}

export const projectBytes = (data: SavedProjectData): number =>
  data.files.reduce((sum, file) => sum + file.blob.size, 0);

/** A name to suggest when a project is first saved. */
export function defaultProjectName(state: Pick<ProjectSource, 'kind' | 'photos' | 'video'>): string {
  const base =
    state.kind === 'video' && state.video
      ? state.video.name
      : state.photos[0]?.name ?? 'Project';
  // Drop the extension; the list already says what kind of project it is.
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  return stem.length > 0 ? stem : 'Project';
}

/**
 * Turns stored files back into `File`s. Blobs come back from IndexedDB as
 * plain Blobs in some browsers, and the import path wants a name and type.
 */
export function toFiles(data: SavedProjectData): File[] {
  return data.files.map((stored) => new File([stored.blob], stored.name, { type: stored.type }));
}
