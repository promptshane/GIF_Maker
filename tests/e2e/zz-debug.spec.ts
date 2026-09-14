import { test } from '@playwright/test';
import { importPhotos, openApp, PHOTOS } from './helpers';
test('debug idb', async ({ page }) => {
  await openApp(page);
  await importPhotos(page, [PHOTOS[2]]);
  const out = await page.evaluate(async () => {
    const results: string[] = [];
    const open = () => new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('dbg', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('s', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const db = await open();
    const tryPut = async (label: string, value: unknown) => {
      try {
        await new Promise<void>((res, rej) => {
          const tx = db.transaction('s', 'readwrite');
          const req = tx.objectStore('s').put(value);
          req.onerror = () => rej(new Error('req: ' + String(req.error?.name) + ' ' + String(req.error?.message)));
          tx.onerror = () => rej(new Error('tx: ' + String(tx.error?.name) + ' ' + String(tx.error?.message)));
          tx.onabort = () => rej(new Error('abort: ' + String(tx.error?.name) + ' ' + String(tx.error?.message)));
          tx.oncomplete = () => res();
        });
        results.push(label + ': ok');
      } catch (e) { results.push(label + ': ' + String((e as Error).message)); }
    };
    await tryPut('plain', { id: 'a', x: 1 });
    await tryPut('blob', { id: 'b', blob: new Blob(['hello'], { type: 'text/plain' }) });
    const input = document.querySelector<HTMLInputElement>('input[type=file]');
    void input;
    // Get the File the store holds via a picked photo: read it through the app's own store is not exposed; make a File instead.
    await tryPut('file-made', { id: 'c', blob: new File(['hello'], 'x.txt', { type: 'text/plain' }) });
    const w = window as unknown as { __store?: unknown };
    results.push('store exposed: ' + String(!!w.__store));
    return results;
  });
  console.log('RESULTS', JSON.stringify(out));
});
