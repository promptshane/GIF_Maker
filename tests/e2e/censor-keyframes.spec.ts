import { expect, test, type Page } from '@playwright/test';
import { countPixels, frameRgb, generate, importVideo, openApp, openTab, probeGif, readResultGif } from './helpers';

/**
 * Drags the selected overlay so its centre lands at a fraction of the preview,
 * which keeps the test independent of the viewport size.
 */
async function dragOverlayTo(page: Page, fx: number, fy: number) {
  const stage = (await page.locator('.stage-inner').boundingBox())!;
  const rect = (await page.locator('.selection-box').first().boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * fx, stage.y + stage.height * fy, { steps: 12 });
  await page.mouse.up();
}

test('a censor region follows keyframes across the timeline', async ({ page }) => {
  await openApp(page);
  await importVideo(page);
  await openTab(page, 'Edit');
  await page.getByRole('button', { name: '10', exact: true }).click();

  await openTab(page, 'Censor');
  await page.getByRole('button', { name: '+ Pixelate box' }).click();
  await page.getByRole('slider', { name: 'Censor strength' }).fill('100');
  await page.getByRole('slider', { name: 'Censor width' }).fill('30');
  await page.getByRole('slider', { name: 'Censor height' }).fill('45');

  const scrub = page.getByRole('slider', { name: 'Preview position' });

  // The fixture's block sweeps from ~13% to ~92% of the frame width at y ~50%.
  // Keyframe 1: park the region on it at the start.
  await scrub.fill('0');
  await dragOverlayTo(page, 0.13, 0.5);

  // Keyframe 2: at the end of the clip, follow the block to the right.
  const duration = Number(await scrub.getAttribute('max'));
  await scrub.fill(String(duration - 60));
  await page.getByRole('button', { name: /Keyframe at/ }).click();
  await expect(page.locator('.tool-panel')).toContainText('2 keyframes');
  await dragOverlayTo(page, 0.9, 0.5);

  await generate(page);
  const bytes = await readResultGif(page);
  const { frames } = probeGif(bytes);

  // Pixelating a hard-edged block produces blended colours that exist nowhere
  // in the clean source. Finding them at *both* ends proves the region tracked
  // the block rather than sitting still.
  const isBlend = (r: number, g: number, b: number) =>
    r > 60 && r < 240 && g > 40 && g < 190 && b < 140 && Math.abs(r - g) > 15;

  expect(countPixels(frameRgb(bytes, 1), isBlend)).toBeGreaterThan(60);
  expect(countPixels(frameRgb(bytes, frames - 2), isBlend)).toBeGreaterThan(60);

  // And a frame in the middle is also covered, i.e. the position really is
  // interpolated rather than snapping between the two keyframes.
  expect(countPixels(frameRgb(bytes, Math.floor(frames / 2)), isBlend)).toBeGreaterThan(60);
});
