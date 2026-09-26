export interface SavedVideoFrameProjectMeta {
  id: string;
  name: string;
  savedAt: number;
  videoName: string;
  bytes: number;
  frameCount: number;
  replacementCount: number;
}

export interface StoredVideoFrameReplacement {
  index: number;
  name: string;
  type: string;
  blob: Blob;
}

export interface SavedVideoFrameProjectData {
  id: string;
  version: 1;
  video: {
    name: string;
    type: string;
    blob: Blob;
  };
  replacements: StoredVideoFrameReplacement[];
}

const DB_NAME = 'gifmaker-video-frame-projects';
const DB_VERSION = 1;
const META = 'meta';
const DATA = 'data';

export const videoFrameProjectsSupported = (): boolean =>
  typeof indexedDB !== 'undefined' && indexedDB !== null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Storage request failed.'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Storage transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction was aborted.'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Could not open video-project storage.'));
    };
    req.onblocked = () => reject(new Error('Video-project storage is in use by another tab.'));
  });
  return dbPromise;
}

export async function putVideoFrameProject(
  meta: SavedVideoFrameProjectMeta,
  data: SavedVideoFrameProjectData,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, DATA], 'readwrite');
  let failure: unknown = null;
  for (const req of [tx.objectStore(META).put(meta), tx.objectStore(DATA).put(data)]) {
    req.onerror = () => {
      failure ??= req.error;
    };
  }
  try {
    await done(tx);
  } catch (error) {
    throw failure ?? error;
  }
}

export async function listVideoFrameProjects(): Promise<SavedVideoFrameProjectMeta[]> {
  const db = await openDb();
  const tx = db.transaction(META, 'readonly');
  const rows = await request(
    tx.objectStore(META).getAll() as IDBRequest<SavedVideoFrameProjectMeta[]>,
  );
  await done(tx);
  return rows.sort((a, b) => b.savedAt - a.savedAt);
}

export async function getVideoFrameProject(id: string): Promise<SavedVideoFrameProjectData | null> {
  const db = await openDb();
  const tx = db.transaction(DATA, 'readonly');
  const row = await request(
    tx.objectStore(DATA).get(id) as IDBRequest<SavedVideoFrameProjectData | undefined>,
  );
  await done(tx);
  return row ?? null;
}

export async function deleteVideoFrameProject(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, DATA], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(DATA).delete(id);
  await done(tx);
}
