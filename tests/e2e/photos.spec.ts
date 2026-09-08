import { expect, test } from '@playwright/test';
import {
  closeSheet, generate, importPhotos, openApp, openTab, probeGif, readResultGif, PHOTOS,
} from './helpers';

test.describe('Photo workflow', () => {
  test('import, reorder, retime, preview and export', async ({ page }) => {
    await openApp(page);
    await importPhotos(page);

    await openTab(page, 'Edit');
    const strip = page.locator('.strip-item');
    await expect(strip).toHaveCount(3);

    // Default is 0.6s each -> 1.8s total.
    await expect(page.locator('.stage-meta')).toContainText('1.8s');

    // Reorder: move the first photo one place later and confirm the strip order
    // changed (thumbnail 1 becomes thumbnail 2).
    const firstThumb = await strip.nth(0).locator('img').getAttribute('src');
    await strip.nth(0).click();
    await page.getByRole('button', { name: 'Move photo later' }).click();
    await expect(strip.nth(1).locator('img')).toHaveAttribute('src', firstThumb!);

    // Duplicate and delete both take effect on the timeline.
    await page.getByRole('button', { name: 'Duplicate photo' }).click();
    await expect(strip).toHaveCount(4);
    await page.getByRole('button', { name: 'Delete photo' }).click();
    await expect(strip).toHaveCount(3);

    // Per-photo duration.
    await strip.nth(0).click();
    await page.getByRole('slider', { name: 'Duration of photo 1' }).fill('2000');
    await expect(page.locator('.strip-item').nth(0)).toContainText('2.00s');
    await expect(page.locator('.stage-meta')).toContainText('3.2s');

    // "Apply to all" pushes the selected photo's duration onto every photo.
    await page.getByRole('slider', { name: 'Duration of photo 1' }).fill('500');
    await page.getByRole('button', { name: 'Apply this duration to every photo' }).click();
    await expect(page.locator('.stage-meta')).toContainText('1.5s');

    await generate(page);
    const gif = probeGif(await readResultGif(page));

    // Static photos merge into one GIF frame each, so three photos = three frames.
    expect(gif.frames).toBe(3);
    expect(gif.width).toBeGreaterThan(0);
    expect(gif.bytes).toBeGreaterThan(200);

    // The displayed size matches the real file, within the rounding the
    // display itself applies (0.01 MB, or 0.1 KB for small files).
    const shown = await page.locator('.result-size').innerText();
    const value = Number(shown.replace(/[^\d.]/g, ''));
    const unit = shown.includes('MB') ? 1024 * 1024 : 1024;
    const step = shown.includes('MB') ? 0.01 : 0.1;
    expect(Math.abs(value * unit - gif.bytes)).toBeLessThanOrEqual((unit * step) / 2 + 1);
  });

  test('per-photo durations survive into the encoded frame delays', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, PHOTOS.slice(0, 2));
    await openTab(page, 'Edit');

    await page.locator('.strip-item').nth(0).click();
    await page.getByRole('slider', { name: 'Duration of photo 1' }).fill('1500');
    await page.locator('.strip-item').nth(1).click();
    await page.getByRole('slider', { name: 'Duration of photo 2' }).fill('300');
    await expect(page.locator('.stage-meta')).toContainText('1.8s');

    await generate(page);
    const bytes = await readResultGif(page);
    expect(probeGif(bytes).frames).toBe(2);

    // Read the Graphic Control Extension delays straight out of the file.
    const delays: number[] = [];
    for (let i = 0; i + 8 < bytes.length; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
        delays.push(bytes.readUInt16LE(i + 4) * 10);
      }
    }
    expect(delays).toEqual([1500, 300]);
    await closeSheet(page);
  });

  test('rejects a file the browser cannot decode', async ({ page }) => {
    await openApp(page);
    await page.locator('input[type=file][multiple]').first().setInputFiles({
      name: 'broken.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('this is definitely not a jpeg'),
    });
    await expect(page.getByRole('alert')).toContainText('could not be opened');
    // And it does not silently move on to the editor.
    await expect(page.getByRole('heading', { name: 'Make a GIF' })).toBeVisible();
  });
});
