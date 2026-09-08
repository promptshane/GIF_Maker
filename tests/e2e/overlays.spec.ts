import { expect, test } from '@playwright/test';
import {
  countPixels, frameDifference, frameRgb, generate, importPhotos, openApp, openTab, PHOTOS,
  readResultGif,
} from './helpers';

/** Reopens the export sheet after a previous result, without leaving the editor. */
async function backToEditor(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Change quality and regenerate' }).click();
  await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole('dialog')).toBeHidden();
}

test.describe('Overlays', () => {
  test('an emoji is drawn into the exported GIF and can be moved and resized', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, [PHOTOS[0]]);

    await generate(page);
    const plain = frameRgb(await readResultGif(page), 0);
    await backToEditor(page);

    await openTab(page, 'Emoji');
    await page.getByRole('button', { name: 'Add 🔥' }).click();
    await page.getByRole('slider', { name: 'Emoji size' }).fill('80');

    await generate(page);
    const withEmoji = frameRgb(await readResultGif(page), 0);
    expect(withEmoji.width).toBe(plain.width);
    const added = frameDifference(plain.data, withEmoji.data);
    expect(added).toBeGreaterThan(2);
    await backToEditor(page);

    // Dragging on the preview must change where it lands in the export.
    const overlay = page.locator('.selection-box').first();
    const rect = (await overlay.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 - 60, rect.y + rect.height / 2 - 50, { steps: 10 });
    await page.mouse.up();

    await generate(page);
    const moved = frameRgb(await readResultGif(page), 0);
    expect(frameDifference(withEmoji.data, moved.data)).toBeGreaterThan(1);
  });

  test('a time-limited emoji only appears in part of the GIF', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, PHOTOS);

    await openTab(page, 'Emoji');
    await page.getByRole('button', { name: 'Add ⭐️' }).click();
    await page.getByRole('slider', { name: 'Emoji size' }).fill('90');
    await page.getByRole('button', { name: 'Time range' }).click();
    // Playhead sits at 0 initially; end the range early so only photo 1 has it.
    await page.getByRole('slider', { name: 'Preview position' }).fill('300');
    await page.getByRole('button', { name: 'End here' }).click();

    await generate(page);
    const bytes = await readResultGif(page);
    const first = frameRgb(bytes, 0);
    const last = frameRgb(bytes, 2);

    // The overlay changes the first photo but not the last, so the two frames
    // differ by more than just their own background colours would suggest.
    const firstNonFlat = countPixels(first, (r, g, b) => r > 150 && g > 100 && b < 120);
    const lastNonFlat = countPixels(last, (r, g, b) => r > 150 && g > 100 && b < 120);
    expect(firstNonFlat).toBeGreaterThan(lastNonFlat + 200);
  });
});

test.describe('Censor', () => {
  test('blur and pixelate both alter the exported pixels', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, [PHOTOS[0]]);

    await generate(page);
    const plainBytes = await readResultGif(page);
    const plain = frameRgb(plainBytes, 0);
    await backToEditor(page);

    // The source photo is a flat red field with a hard-edged white square, so
    // any genuine blur/pixelation introduces intermediate colours that simply
    // do not exist in the original.
    const isIntermediate = (r: number, g: number, b: number) =>
      g > 60 && g < 200 && r > 120;
    expect(countPixels(plain, isIntermediate)).toBeLessThan(plain.width * 2);

    await openTab(page, 'Censor');
    await page.getByRole('button', { name: '+ Blur box' }).click();
    await page.getByRole('slider', { name: 'Censor strength' }).fill('90');
    await page.getByRole('slider', { name: 'Censor width' }).fill('60');
    await page.getByRole('slider', { name: 'Censor height' }).fill('60');

    // Drag it over the hard edge of the white square.
    const region = page.locator('.selection-box').first();
    const rect = (await region.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 - 40, rect.y + rect.height / 2 - 40, { steps: 8 });
    await page.mouse.up();

    await generate(page);
    const blurred = frameRgb(await readResultGif(page), 0);
    const blurredMix = countPixels(blurred, isIntermediate);
    expect(blurredMix).toBeGreaterThan(plain.width * 4);
    await backToEditor(page);

    // Switching to pixelate must produce a different image, not the same one.
    await page.locator('.segmented').getByRole('button', { name: 'Pixelate', exact: true }).click();
    await generate(page);
    const pixelated = frameRgb(await readResultGif(page), 0);
    expect(frameDifference(blurred.data, pixelated.data)).toBeGreaterThan(0.5);
    await backToEditor(page);

    // Strength genuinely changes the result too.
    await page.locator('.segmented').getByRole('button', { name: 'Blur', exact: true }).click();
    await page.getByRole('slider', { name: 'Censor strength' }).fill('10');
    await generate(page);
    const weak = frameRgb(await readResultGif(page), 0);
    expect(frameDifference(blurred.data, weak.data)).toBeGreaterThan(0.5);
  });
});
