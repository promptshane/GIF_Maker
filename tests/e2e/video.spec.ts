import { expect, test } from '@playwright/test';
import {
  countPixels, frameRgb, generate, importVideo, isOrange, openApp, openTab, probeGif, readResultGif,
} from './helpers';

test.describe('Video workflow', () => {
  test('trim, speed and frame rate change the encoded output', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Timing');

    // Default trim is the first 5s of a 4s clip -> the whole clip.
    await expect(page.locator('.meta-row')).toContainText('4.0s');

    // Trim by dragging the end grip to roughly the middle of the rail.
    const rail = page.locator('.trim-rail');
    const railBox = (await rail.boundingBox())!;
    await page.locator('.trim-grip').nth(1).hover();
    await page.mouse.down();
    await page.mouse.move(railBox.x + railBox.width * 0.5, railBox.y + railBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.busy-veil')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('.meta-row')).toContainText('2.0s');

    // 15 FPS over ~2s is about 30 frames.
    await page.getByRole('button', { name: '15', exact: true }).click();
    const framesText = await page.locator('.meta-row .chip').nth(2).innerText();
    expect(Number(framesText.replace(/\D/g, ''))).toBeGreaterThan(20);

    // 2x speed halves the duration.
    await page.getByRole('button', { name: '2×' }).click();
    await expect(page.locator('.meta-row')).toContainText('1.0s');

    await generate(page);
    const gif = probeGif(await readResultGif(page));
    expect(gif.frames).toBeGreaterThan(10);
    expect(gif.width).toBeGreaterThan(0);
  });

  test('frame rate selection changes the real frame count', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Timing');

    await page.getByRole('button', { name: '10', exact: true }).click();
    await generate(page);
    const slow = probeGif(await readResultGif(page));
    await page.getByRole('button', { name: 'Change quality and regenerate' }).click();
    await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });

    await page.getByRole('button', { name: '30', exact: true }).click();
    await generate(page);
    const fast = probeGif(await readResultGif(page));

    expect(fast.frames).toBeGreaterThan(slow.frames * 2);
  });

  test('60 FPS is honestly reported as the 50 FPS the format allows', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Timing');
    await page.getByRole('button', { name: '60', exact: true }).click();

    await expect(page.locator('.tool-panel')).toContainText('cannot play faster than 50 FPS');
    await expect(page.locator('.meta-row')).toContainText('50 FPS');
  });

  test('cropping reframes the exported pixels', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Timing');
    // Keep it short so the comparison is quick.
    await page.getByRole('button', { name: '10', exact: true }).click();

    await openTab(page, 'Frame');
    await page.locator('.segmented', { hasText: 'Fill' }).getByRole('button', { name: 'Fill' }).click();
    await generate(page);
    const filledBytes = await readResultGif(page);
    const midFrame = Math.floor(probeGif(filledBytes).frames / 2);
    const filled = frameRgb(filledBytes, midFrame);
    await page.getByRole('button', { name: 'Change quality and regenerate' }).click();
    await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });

    await page.getByRole('button', { name: 'Crop' }).click();
    await page.getByRole('button', { name: 'Reframe on image' }).click();

    // Shrink the crop rectangle sharply. It resizes about its centre, which is
    // where the fixture's moving block sits at the midpoint of the clip.
    const handle = page.getByLabel('Resize crop area');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 150, box.y - 90, { steps: 12 });
    await page.mouse.up();

    await page.getByRole('button', { name: 'Done reframing' }).click();
    await generate(page);
    const cropped = frameRgb(await readResultGif(page), midFrame);

    // Output dimensions are untouched by cropping...
    expect(cropped.width).toBe(filled.width);
    expect(cropped.height).toBe(filled.height);
    // ...but the framing zoomed in, so the block covers far more pixels.
    const before = countPixels(filled, isOrange);
    const after = countPixels(cropped, isOrange);
    expect(before).toBeGreaterThan(500);
    expect(after).toBeGreaterThan(before * 1.5);
  });
});
