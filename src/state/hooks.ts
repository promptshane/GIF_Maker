import { useMemo } from 'react';
import { sourceDimensions, useStore } from './store';
import { PhotoFrameProvider, type FrameProvider } from '../media/frames';
import {
  buildPhotoPlan,
  buildVideoPlan,
  mergeStaticFrames,
  type FramePlan,
} from '../render/timeline';
import type { RenderSettings } from '../export/renderPipeline';

/**
 * The frame plan, memoised on its real inputs.
 *
 * This must not be a zustand selector: the plan is a fresh object each time it
 * is derived, and `useSyncExternalStore` requires a stable snapshot.
 */
export function useFramePlan(): FramePlan {
  const kind = useStore((state) => state.kind);
  const photos = useStore((state) => state.photos);
  const video = useStore((state) => state.video);
  const videoSettings = useStore((state) => state.videoSettings);
  const fps = useStore((state) => state.fps);
  const stickers = useStore((state) => state.stickers);
  const censors = useStore((state) => state.censors);

  return useMemo(() => {
    const base =
      kind === 'video' && video
        ? buildVideoPlan({
            trimStart: videoSettings.trimStart,
            trimEnd: videoSettings.trimEnd,
            fps,
            speed: videoSettings.speed,
            direction: videoSettings.direction,
          })
        : buildPhotoPlan(photos.map((photo) => photo.durationMs), fps);
    return mergeStaticFrames(base, stickers, censors);
  }, [kind, photos, video, videoSettings, fps, stickers, censors]);
}

export function useRenderSettings(): RenderSettings {
  const canvas = useStore((state) => state.canvas);
  const crop = useStore((state) => state.crop);
  const stickers = useStore((state) => state.stickers);
  const censors = useStore((state) => state.censors);

  return useMemo(
    () => ({
      width: canvas.width,
      height: canvas.height,
      fitMode: canvas.fitMode,
      crop,
      background: canvas.background,
      stickers,
      censors,
    }),
    [canvas, crop, stickers, censors],
  );
}

/** Pixel size of the source the crop is framed against (video, or first photo). */
export function useSourceDimensions(): { width: number; height: number } {
  const width = useStore((state) => sourceDimensions(state).width);
  const height = useStore((state) => sourceDimensions(state).height);
  return useMemo(() => ({ width, height }), [width, height]);
}

/** Frame source for the live preview: photo bitmaps, or cached video frames. */
export function usePreviewProvider(): FrameProvider | null {
  const kind = useStore((state) => state.kind);
  const photos = useStore((state) => state.photos);
  const previewCache = useStore((state) => state.previewCache);

  return useMemo(
    () => (kind === 'photos' ? new PhotoFrameProvider(photos) : previewCache),
    [kind, photos, previewCache],
  );
}
