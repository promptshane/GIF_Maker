import { expect, test } from '@playwright/test';
import { PHOTOS } from './helpers';

async function openPhotoEditor(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit Photo' }).click();
  await page.locator('input[type=file][accept^="image"]').setInputFiles(PHOTOS[0]);
  await expect(page.getByRole('button', { name: 'Save Photo' })).toBeVisible();
}

test.describe('Additional photo censors', () => {
  test('new effects are selectable and custom color alters exported preview', async ({ page }) => {
    await openPhotoEditor(page);
    await page.getByRole('button', { name: '+ Blur box' }).click();
    const effect = page.getByRole('combobox', { name: 'Censor effect' });
    for (const choice of ['smear', 'noise', 'glass', 'spotlight']) {
      await effect.selectOption(choice);
      await expect(effect).toHaveValue(choice);
    }
    await effect.selectOption('color');
    await page.locator('input[aria-label="Censor color"]').fill('#00ff00');
    await page.getByRole('slider', { name: 'Censor opacity' }).fill('100');

    // The native photo preview actually renders the changed pixels.
    const preview = page.locator('.stage-inner canvas');
    await expect.poll(async () => preview.evaluate((canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      const pixel = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height * 0.45), 1, 1).data;
      return pixel[1] > 170 && pixel[0] < 90 && pixel[2] < 90;
    })).toBe(true);
  });

  test('drawing a brush stroke creates a selected, editable and saved censor', async ({ page }) => {
    await openPhotoEditor(page);
    await page.getByRole('button', { name: /Freehand brush/ }).click();
    const brush = page.locator('.brush-draw-layer');
    await expect(brush).toBeVisible();
    const bounds = (await brush.boundingBox())!;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(bounds.x + bounds.width * 0.25, y);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.75, y, { steps: 14 });
    await page.mouse.up();
    await expect(page.getByRole('button', { name: /1\. Blur stroke/ })).toBeVisible();
    await page.getByRole('button', { name: /Done brushing/ }).click();
    await page.getByRole('combobox', { name: 'Censor effect' }).selectOption('color');
    await page.locator('input[aria-label="Censor color"]').fill('#00ff00');
    await page.getByRole('button', { name: 'Save Photo' }).click();
    await expect(page.getByRole('img', { name: 'Edited photo export preview' })).toBeVisible();
  });

  test('auto-face detection creates individual regions with an on-device detector', async ({ page }) => {
    // Stub only model loading/inference; exercise actual UI and stored regions.
    await page.route('**/vision_bundle.mjs', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        contentType: 'text/javascript',
        body: `
          export const FilesetResolver = { forVisionTasks: async () => ({}) };
          export const FaceDetector = { createFromOptions: async () => ({
            detect: (canvas) => ({ detections: [{ boundingBox: {
              originX: canvas.width * 0.25, originY: canvas.height * 0.25,
              width: canvas.width * 0.25, height: canvas.height * 0.3
            } }] }),
            close: () => {}
          }) };
        `,
      });
    });
    await openPhotoEditor(page);
    await page.getByRole('button', { name: /Detect faces/ }).click();
    await expect(page.getByRole('status')).toContainText('Added blur regions to 1 face');
    await expect(page.locator('.selection-box.censor.circle')).toHaveCount(1);
  });
});
