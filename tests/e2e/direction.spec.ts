import { expect, test } from '@playwright/test';
import {
  frameRgb, generate, importVideo, openApp, openTab, orangeCentroidX, probeGif, readResultGif,
} from './helpers';

/** Positions of the moving block across every frame of the exported GIF. */
function sweep(bytes: Buffer): number[] {
  const { frames } = probeGif(bytes);
  const positions: number[] = [];
  for (let i = 0; i < frames; i++) {
    const x = orangeCentroidX(frameRgb(bytes, i));
    if (x !== null) positions.push(x);
  }
  return positions;
}

test.describe('Playback direction', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Edit');
    // Keep it cheap: 10 FPS over the whole 4s clip.
    await page.getByRole('button', { name: '10', exact: true }).click();
  });

  test('forward runs start to end', async ({ page }) => {
    await generate(page);
    const positions = sweep(await readResultGif(page));
    expect(positions.length).toBeGreaterThan(6);
    expect(positions[positions.length - 1]).toBeGreaterThan(positions[0] + 100);
  });

  test('reverse runs end to start', async ({ page }) => {
    await page.getByRole('button', { name: 'Reverse' }).click();
    await generate(page);
    const positions = sweep(await readResultGif(page));
    expect(positions.length).toBeGreaterThan(6);
    expect(positions[positions.length - 1]).toBeLessThan(positions[0] - 100);
  });

  test('boomerang goes out and back without repeating the turnaround', async ({ page }) => {
    await generate(page);
    const forwardFrames = probeGif(await readResultGif(page)).frames;
    await page.getByRole('button', { name: 'Change quality and regenerate' }).click();
    await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });

    await page.getByRole('button', { name: 'Boomerang' }).click();
    await generate(page);
    const bytes = await readResultGif(page);
    const info = probeGif(bytes);

    // 2N-2: the forward pass plus the return, with both endpoints dropped so
    // neither the turnaround nor the loop point shows a doubled frame.
    expect(info.frames).toBe(forwardFrames * 2 - 2);

    const positions = sweep(bytes);
    const peak = positions.indexOf(Math.max(...positions));
    // The block travels out, peaks near the middle, and comes back.
    expect(peak).toBeGreaterThan(positions.length * 0.3);
    expect(peak).toBeLessThan(positions.length * 0.7);

    // The loop point is seamless: the last frame is one step away from the
    // first, not a repeat of it and not a jump.
    const step = Math.abs(positions[1] - positions[0]);
    const wrap = Math.abs(positions[0] - positions[positions.length - 1]);
    expect(wrap).toBeGreaterThan(step * 0.5);
    expect(wrap).toBeLessThan(step * 1.8);

    // Neither the turnaround nor the loop point repeats a frame.
    expect(frameRgb(bytes, peak).data.equals(frameRgb(bytes, peak + 1).data)).toBe(false);
    expect(frameRgb(bytes, 0).data.equals(frameRgb(bytes, info.frames - 1).data)).toBe(false);
  });
});
