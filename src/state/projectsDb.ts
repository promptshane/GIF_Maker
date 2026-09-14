import type { SavedProjectData, SavedProjectMeta } from './projects';

/**
 * On-device storage for saved projects, on IndexedDB.
 *
 * IndexedDB is the only browser storage that takes Blobs without copying them
 * through a string, which is what makes storing a whole video file practical.
 * Everything here stays in the browser's storage on this device: nothing is
 * uploaded and nothing syncs.
 *
 * Two object stores share one database so the home screen can list projects
 * without touching the media rows at all.
 */

const DB_NAME = 'gifmaker-projects';
const DB_VERSION = 1;
const META = 'meta';
const DATA = 'data';

/** True when this browser exposes IndexedDB at all. */
export const projectsSupported = (): boolean =>
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
      // If another tab upgrades the schema, drop our handle so the next call reopens.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Could not open project storage.'));
    };
    req.onblocked = () => reject(new Error('Project storage is in use by another tab.'));
  });
  return dbPromise;
}

/** Writes (or overwrites) a project's list row and its media in one transaction. */
export async function putProject(meta: SavedProjectMeta, data: SavedProjectData): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, DATA], 'readwrite');
  // A failed put aborts the transaction with the detail on the *request*, so
  // capture that: the transaction's own error is often empty.
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

/** Newest first. */
export async function listProjects(): Promise<SavedProjectMeta[]> {
  const db = await openDb();
  const tx = db.transaction(META, 'readonly');
  const rows = await request(tx.objectStore(META).getAll() as IDBRequest<SavedProjectMeta[]>);
  await done(tx);
  return rows.sort((a, b) => b.savedAt - a.savedAt);
}

export async function getProjectMeta(id: string): Promise<SavedProjectMeta | null> {
  const db = await openDb();
  const tx = db.transaction(META, 'readonly');
  const row = await request(tx.objectStore(META).get(id) as IDBRequest<SavedProjectMeta | undefined>);
  await done(tx);
  return row ?? null;
}

export async function getProject(id: string): Promise<SavedProjectData | null> {
  const db = await openDb();
  const tx = db.transaction(DATA, 'readonly');
  const row = await request(tx.objectStore(DATA).get(id) as IDBRequest<SavedProjectData | undefined>);
  await done(tx);
  return row ?? null;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, DATA], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(DATA).delete(id);
  await done(tx);
}

/** Bytes used and available for this site, when the browser will say. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    if (usage === undefined || quota === undefined) return null;
    return { usage, quota };
  } catch {
    return null;
  }
}

/**
 * Asks the browser not to evict this site's storage under pressure. Best
 * effort: the answer is advisory and some browsers grant it silently for
 * installed apps.
 */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return;
    await navigator.storage?.persist?.();
  } catch {
    // Not supported or refused; saving still works, it is just evictable.
  }
}

/** True for the error IndexedDB raises when the origin's quota is exhausted. */
export const isQuotaError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'QuotaExceededError';

/**
 * WebKit keeps IndexedDB in memory for Private Browsing, and that store
 * cannot hold Blobs — the media a project is made of. It fails with an
 * UnknownError that names Blob/File, which is the only way to tell it apart.
 */
export const isEphemeralStorageError = (error: unknown): boolean =>
  error instanceof DOMException &&
  error.name === 'UnknownError' &&
  /blob|file/i.test(error.message);
