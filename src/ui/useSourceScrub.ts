import { useEffect, useRef, useState } from 'react';
import type { FrameImage } from '../media/frames';
import type { VideoFrameReader } from '../media/video';

interface ScrubState {
  frame: FrameImage | null;
  /** Bumped on every decoded frame so the preview redraws. */
  revision: number;
}

/**
 * Decodes the exact source frame at a timestamp, for scrubbing a trim handle.
 *
 * Seeks are serialised and latest-wins: while one is in flight the newest
 * requested time is remembered and jumped to as soon as it finishes, so
 * dragging never queues up a backlog of stale seeks. The frame comes from the
 * real video rather than the preview cache, which only covers the current trim
 * range and so cannot show you where a *new* trim point lands.
 */
export function useSourceScrub(
  reader: VideoFrameReader | null,
  timeSeconds: number | null,
): ScrubState {
  const [state, setState] = useState<ScrubState>({ frame: null, revision: 0 });
  const targetRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    targetRef.current = timeSeconds;

    if (timeSeconds === null) {
      setState((prev) => (prev.frame === null ? prev : { frame: null, revision: prev.revision + 1 }));
      return;
    }
    if (!reader || runningRef.current) return;

    runningRef.current = true;
    void (async () => {
      try {
        while (aliveRef.current) {
          const target = targetRef.current;
          if (target === null) break;
          await reader.seek(target);
          if (!aliveRef.current || targetRef.current === null) break;
          setState((prev) => ({
            // The <video> element is the image source and is mutated in place,
            // so the revision counter is what tells the preview to repaint.
            frame: { image: reader.element, width: reader.width, height: reader.height },
            revision: prev.revision + 1,
          }));
          // Settled: nothing newer was requested while we were seeking.
          if (targetRef.current === target) break;
        }
      } catch {
        // A failed seek just leaves the last good frame on screen.
      } finally {
        runningRef.current = false;
      }
    })();
  }, [reader, timeSeconds]);

  return state;
}
