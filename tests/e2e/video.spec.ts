import { expect, test } from '@playwright/test';
import {
  countPixels, frameDifference, frameRgb, generate, importVideo, isOrange, openApp, openTab, probeGif,
  readResultGif,
} from './helpers';

test.describe('Video workflow', () => {
  test('trim, speed and frame rate change the encoded output', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Edit');

    // Default trim is the first 5s of a 4s clip -> the whole clip.
    await expect(page.locator('.stage-meta')).toContainText('4.0s');

    // Trim by dragging the end grip to roughly the middle of the rail.
    const rail = page.locator('.trim-rail');
    const railBox = (await rail.boundingBox())!;
    await page.locator('.trim-grip').nth(1).hover();
    await page.mouse.down();
    await page.mouse.move(railBox.x + railBox.width * 0.5, railBox.y + railBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.stage-meta')).toContainText('2.0s');

    // 15 FPS over ~2s is about 30 frames.
    await page.getByRole('button', { name: '15', exact: true }).click();
    const framesText = await page.locator('.stage-meta span').nth(2).innerText();
    expect(Number(framesText.replace(/\D/g, ''))).toBeGreaterThan(20);

    // 2x speed halves the duration.
    await page.getByRole('button', { name: '2×' }).click();
    await expect(page.locator('.stage-meta')).toContainText('1.0s');

    await generate(page);
    const gif = probeGif(await readResultGif(page));
    expect(gif.frames).toBeGreaterThan(10);
    expect(gif.width).toBeGreaterThan(0);
  });

  test('trimming shows the frame under the handle and defers the rebuild', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Edit');

    const rail = page.locator('.trim-rail');
    const railBox = (await rail.boundingBox())!;
    const canvas = page.locator('.stage-inner canvas');

    /** Mean colour of the preview canvas, to tell frames apart. */
    const previewColour = () =>
      canvas.evaluate((el: HTMLCanvasElement) => {
        const ctx = el.getContext('2d')!;
        const { data } = ctx.getImageData(0, 0, el.width, el.height);
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
        const n = data.length / 4;
        return [r / n, g / n, b / n];
      });

    // Drag the start grip well into the clip and hold it there.
    await page.locator('.trim-grip').nth(0).hover();
    await page.mouse.down();
    await page.mouse.move(railBox.x + railBox.width * 0.7, railBox.y + railBox.height / 2, { steps: 10 });

    // The preview must land on that exact source frame, decoded live — the
    // frame cache only covers the old trim range and could not show this.
    await expect(page.locator('.stage-meta')).toBeVisible();
    await page.waitForTimeout(1200);
    const held = await previewColour();
    await page.mouse.up();

    // Releasing must NOT kick off a cache rebuild; fine-tuning would be
    // unusable if every adjustment blocked on a decode pass.
    await expect(page.locator('.busy-veil')).toBeHidden();
    await expect(page.locator('.tool-panel')).toContainText('Press play to build the preview');

    // The frame stays on screen after release rather than snapping back.
    const afterRelease = await previewColour();
    expect(Math.abs(afterRelease[0] - held[0])).toBeLessThan(6);

    // Playback is what pays for the rebuild.
    await page.getByRole('button', { name: 'Play preview' }).click();
    await expect(page.locator('.tool-panel')).not.toContainText('Press play to build the preview', {
      timeout: 60_000,
    });
  });

  test('frame rate selection changes the real frame count', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Edit');

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

  test('50 FPS is the highest offered, because the format cannot play faster', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Edit');
    await expect(page.getByRole('button', { name: '60', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '50', exact: true }).click();

    await expect(page.locator('.tool-panel')).toContainText('50 FPS is the fastest a GIF can play');
    await expect(page.locator('.stage-meta')).toContainText('50 FPS');
  });

  test('cropping reframes the exported pixels', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Edit');
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

    // Shrink the crop rectangle sharply from both ends so it stays centred on
    // the fixture's moving block, which sits mid-frame at the midpoint of the
    // clip. Each corner resizes against the opposite one, which stays put.
    const dragHandle = async (label: string, dx: number, dy: number) => {
      const handle = page.getByLabel(label, { exact: true });
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
      await page.mouse.up();
    };
    const topLeftBefore = (await page.getByLabel('Resize crop area from the top left').boundingBox())!;
    await dragHandle('Resize crop area', -120, -70);
    const topLeftAfter = (await page.getByLabel('Resize crop area from the top left').boundingBox())!;
    expect(Math.abs(topLeftAfter.x - topLeftBefore.x)).toBeLessThan(2);
    expect(Math.abs(topLeftAfter.y - topLeftBefore.y)).toBeLessThan(2);
    await dragHandle('Resize crop area from the top left', 120, 70);

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

  test('changing the output shape and back does not leave the crop zoomed in', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Edit');
    await page.getByRole('button', { name: '10', exact: true }).click();

    await openTab(page, 'Frame');
    await page.getByRole('button', { name: 'Crop' }).click();
    await generate(page);
    const beforeBytes = await readResultGif(page);
    const midFrame = Math.floor(probeGif(beforeBytes).frames / 2);
    const before = frameRgb(beforeBytes, midFrame);
    await page.getByRole('button', { name: 'Change quality and regenerate' }).click();
    await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });

    // Wander through other shapes and come back. Each change used to shrink
    // the crop a little further, and it never recovered.
    for (const preset of ['4:5', '1:1', '16:9', '4:5', 'Original']) {
      await page.getByRole('button', { name: preset, exact: true }).click();
    }
    await generate(page);
    const after = frameRgb(await readResultGif(page), midFrame);

    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect(frameDifference(before.data, after.data)).toBeLessThan(1);
  });

  test('typing an output width keeps the locked aspect ratio', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Frame');
    await expect(page.locator('.stage-meta')).toContainText('640×360');

    // Typed one key at a time: "5" and "50" on the way to "500" must not be
    // applied as real sizes, which is what used to collapse 16:9 to a square.
    const width = page.getByRole('spinbutton', { name: 'Output width' });
    await width.fill('');
    await width.pressSequentially('500');
    await width.press('Enter');
    await expect(page.locator('.stage-meta')).toContainText('500×281');
  });
});
