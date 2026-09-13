import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export const PHOTOS = [
  join(FIXTURES, 'photo-red.jpg'),
  join(FIXTURES, 'photo-green.jpg'),
  join(FIXTURES, 'photo-blue.png'),
];

/**
 * Picks a clip the browser under test can actually decode. Playwright's
 * open-source builds lack H.264, which real iOS Safari has; the app code path
 * is identical either way.
 */
export async function playableClip(page: Page): Promise<string> {
  const canH264 = await page.evaluate(
    () => !!document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'),
  );
  return join(FIXTURES, canH264 ? 'clip.mp4' : 'clip.webm');
}

export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 2, name: 'GIF Maker' })).toBeVisible();
}

export async function importPhotos(page: Page, files: string[] = PHOTOS): Promise<void> {
  await page.locator('input[type=file][multiple]').first().setInputFiles(files);
  await expect(page.getByRole('button', { name: 'Export GIF' })).toBeVisible();
}

export async function importVideo(page: Page): Promise<void> {
  const clip = await playableClip(page);
  await page.locator('input[type=file]:not([multiple])').first().setInputFiles(clip);
  await expect(page.getByRole('button', { name: 'Export GIF' })).toBeVisible({ timeout: 60_000 });
  // Wait for the preview frame cache to finish building.
  await expect(page.locator('.busy-veil')).toBeHidden({ timeout: 60_000 });
}

export async function openTab(page: Page, name: string): Promise<void> {
  await page.locator('.tab', { hasText: name }).click();
}

/** Runs an export at the given quality and waits for the result card. */
export async function generate(
  page: Page,
  quality?: 'Low' | 'Medium' | 'High' | 'Extra High',
): Promise<void> {
  // The sheet may already be open (regenerating at another quality).
  if (!(await page.getByRole('dialog').isVisible())) {
    await page.getByRole('button', { name: 'Export GIF' }).click();
  }
  await expect(page.getByRole('dialog')).toBeVisible();
  if (quality) {
    await page.locator('.quality-opt', { hasText: quality }).first().click();
  }
  await page.getByRole('button', { name: 'Generate GIF' }).click();
  await expect(page.locator('.result-size')).toBeVisible({ timeout: 120_000 });
}

export async function closeSheet(page: Page): Promise<void> {
  await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole('dialog')).toBeHidden();
}

/** Reads the generated GIF out of the page as real bytes. */
export async function readResultGif(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('.result-preview');
    if (!img) throw new Error('no result image');
    const response = await fetch(img.src);
    const buffer = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < buffer.length; i += chunk) {
      binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
    }
    return btoa(binary);
  });
  return Buffer.from(base64, 'base64');
}

export interface GifInfo {
  width: number;
  height: number;
  frames: number;
  bytes: number;
}

/** Decodes the GIF with ffprobe so assertions are about the real file. */
export function probeGif(bytes: Buffer): GifInfo {
  const dir = mkdtempSync(join(tmpdir(), 'gifprobe-'));
  const file = join(dir, 'out.gif');
  writeFileSync(file, bytes);
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
     '-show_entries', 'stream=width,height,nb_read_frames',
     '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  ).trim().split('\n').map((line) => Number(line.trim()));
  return { width: out[0], height: out[1], frames: out[2], bytes: bytes.length };
}

/** Extracts one decoded frame as raw RGB so pixel assertions are possible. */
export function frameRgb(bytes: Buffer, frameIndex: number): { data: Buffer; width: number; height: number } {
  const dir = mkdtempSync(join(tmpdir(), 'gifframe-'));
  const gif = join(dir, 'in.gif');
  const raw = join(dir, 'out.raw');
  writeFileSync(gif, bytes);
  const info = probeGif(bytes);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', gif,
    '-vf', `select=eq(n\\,${frameIndex})`, '-vframes', '1',
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw]);
  return {
    data: Buffer.from(execFileSync('cat', [raw])),
    width: info.width,
    height: info.height,
  };
}

export function pixelAt(
  frame: { data: Buffer; width: number },
  x: number,
  y: number,
): [number, number, number] {
  const i = (y * frame.width + x) * 3;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
}

/** Counts pixels in an RGB frame matching a predicate. */
export function countPixels(
  frame: { data: Buffer; width: number; height: number },
  match: (r: number, g: number, b: number) => boolean,
): number {
  let count = 0;
  for (let i = 0; i + 2 < frame.data.length; i += 3) {
    if (match(frame.data[i], frame.data[i + 1], frame.data[i + 2])) count++;
  }
  return count;
}

export const isWhite = (r: number, g: number, b: number): boolean =>
  r > 200 && g > 200 && b > 200;

/** The fixture clip's moving block (0xFF8800), with quantisation slack. */
export const isOrange = (r: number, g: number, b: number): boolean =>
  r > 170 && g > 90 && g < 200 && b < 110;

/**
 * Horizontal centre of the fixture clip's moving block, in pixels, or null when
 * it is not visible. Lets direction and speed be asserted from real pixels.
 */
export function orangeCentroidX(frame: { data: Buffer; width: number }): number | null {
  let total = 0;
  let weighted = 0;
  for (let i = 0; i + 2 < frame.data.length; i += 3) {
    if (isOrange(frame.data[i], frame.data[i + 1], frame.data[i + 2])) {
      const pixel = i / 3;
      weighted += pixel % frame.width;
      total++;
    }
  }
  return total < 50 ? null : weighted / total;
}

/** Mean absolute difference between two same-sized RGB frames, 0..255. */
export function frameDifference(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i++) total += Math.abs(a[i] - b[i]);
  return total / length;
}
