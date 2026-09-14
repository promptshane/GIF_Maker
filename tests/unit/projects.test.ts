import { describe, expect, it } from 'vitest';
import {
  PROJECT_VERSION,
  defaultProjectName,
  editsSnapshot,
  projectBytes,
  toFiles,
  toProjectData,
  type ProjectSource,
} from '../../src/state/projects';
import type { PhotoAsset } from '../../src/state/types';

const edits = () => ({
  canvas: {
    preset: 'original' as const,
    width: 640,
    height: 480,
    lockAspect: true,
    fitMode: 'crop' as const,
    background: '#000000',
  },
  crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
  videoSettings: { trimStart: 1, trimEnd: 3, direction: 'boomerang' as const, speed: 2 },
  fps: 24,
  quality: 'high' as const,
  stickers: [{ id: 's1', emoji: '🔥', x: 0.5, y: 0.5, size: 0.3, rotation: 0, range: null }],
  censors: [
    {
      id: 'c1',
      shape: 'rect' as const,
      effect: 'blur' as const,
      strength: 0.7,
      range: { startMs: 0, endMs: 500 },
      keyframes: [{ t: 0, x: 0.4, y: 0.4, w: 0.2, h: 0.2 }],
    },
  ],
});

const photo = (id: string, file: Blob, durationMs: number): PhotoAsset => ({
  id,
  name: `${id}.jpg`,
  width: 10,
  height: 10,
  durationMs,
  image: {} as ImageBitmap,
  thumbUrl: 'blob:thumb',
  file,
});

describe('project serialisation', () => {
  it('stores a duplicated photo once and references it by index', () => {
    const a = new Blob(['aaaa'], { type: 'image/jpeg' });
    const b = new Blob(['bb'], { type: 'image/png' });
    const source: ProjectSource = {
      kind: 'photos',
      photos: [photo('p1', a, 300), photo('p2', b, 600), photo('p3', b, 1000)],
      video: null,
      ...edits(),
    };
    const data = toProjectData('id1', source);
    expect(data.version).toBe(PROJECT_VERSION);
    expect(data.files).toHaveLength(2);
    expect(data.photos).toEqual([
      { file: 0, durationMs: 300 },
      { file: 1, durationMs: 600 },
      { file: 1, durationMs: 1000 },
    ]);
    expect(projectBytes(data)).toBe(6);
    // Edits are copied, not shared, so later edits cannot mutate the record.
    expect(data.edits).toEqual(edits());
    expect(data.edits.censors[0]).not.toBe(source.censors[0]);
  });

  it('stores a video as its single file with the edits', () => {
    const clip = new Blob(['xyz'], { type: 'video/mp4' });
    const data = toProjectData('id2', {
      kind: 'video',
      photos: [],
      video: { name: 'clip.mp4', type: 'video/mp4', file: clip },
      ...edits(),
    });
    expect(data.kind).toBe('video');
    expect(data.files).toEqual([{ name: 'clip.mp4', type: 'video/mp4', blob: clip }]);
    const [file] = toFiles(data);
    expect(file.name).toBe('clip.mp4');
    expect(file.type).toBe('video/mp4');
    expect(file.size).toBe(3);
  });

  it('refuses to save an empty project', () => {
    expect(() =>
      toProjectData('id3', { kind: null, photos: [], video: null, ...edits() }),
    ).toThrow();
  });

  it('suggests the media name without its extension', () => {
    expect(
      defaultProjectName({ kind: 'video', photos: [], video: { name: 'IMG_0042.MOV', type: '', file: new Blob() } }),
    ).toBe('IMG_0042');
    expect(defaultProjectName({ kind: 'photos', photos: [], video: null })).toBe('Project');
  });
});

describe('unsaved-change fingerprint', () => {
  const base = (): ProjectSource => ({
    kind: 'photos',
    photos: [photo('p1', new Blob(['a']), 300)],
    video: null,
    ...edits(),
  });

  it('is stable for equal state and changes for any edit', () => {
    expect(editsSnapshot(base())).toBe(editsSnapshot(base()));

    const nudged = base();
    nudged.censors = [
      { ...nudged.censors[0], keyframes: [{ ...nudged.censors[0].keyframes[0], x: 0.41 }] },
    ];
    expect(editsSnapshot(nudged)).not.toBe(editsSnapshot(base()));

    const retimed = base();
    retimed.photos = [{ ...retimed.photos[0], durationMs: 301 }];
    expect(editsSnapshot(retimed)).not.toBe(editsSnapshot(base()));

    const reordered = base();
    reordered.photos = [photo('p2', new Blob(['b']), 300), ...reordered.photos];
    expect(editsSnapshot(reordered)).not.toBe(editsSnapshot(base()));
  });

  it('ignores things a save does not write', () => {
    const a = base();
    const b = base();
    b.photos = [{ ...b.photos[0], thumbUrl: 'blob:other' }];
    expect(editsSnapshot(a)).toBe(editsSnapshot(b));
  });
});
