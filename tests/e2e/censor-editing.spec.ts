import { expect, test } from '@playwright/test';
import { frameRgb, generate, importPhotos, openApp, openTab, PHOTOS, readResultGif } from './helpers';

async function backToEditor(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Change quality and regenerate' }).click();
  await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });
}

test.describe('Censor editing', () => {
  test('nudge moves the region by one step per tap, in every direction', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, [PHOTOS[0]]);
    await openTab(page, 'Censor');
    await page.getByRole('button', { name: '+ Blur box' }).click();

    const stage = (await page.locator('.stage-inner').boundingBox())!;
    const region = page.locator('.selection-box').first();
    const start = (await region.boundingBox())!;
    const step = stage.width * 0.01;

    await page.getByRole('button', { name: 'Nudge right' }).click();
    let now = (await region.boundingBox())!;
    expect(Math.abs(now.x - start.x - step)).toBeLessThan(1);
    expect(Math.abs(now.y - start.y)).toBeLessThan(1);

    await page.getByRole('button', { name: 'Nudge down' }).click();
    await page.getByRole('button', { name: 'Nudge down' }).click();
    now = (await region.boundingBox())!;
    expect(Math.abs(now.y - start.y - stage.height * 0.02)).toBeLessThan(1);

    await page.getByRole('button', { name: 'Nudge left' }).click();
    await page.getByRole('button', { name: 'Nudge up' }).click();
    await page.getByRole('button', { name: 'Nudge up' }).click();
    now = (await region.boundingBox())!;
    expect(Math.abs(now.x - start.x)).toBeLessThan(1);
    expect(Math.abs(now.y - start.y)).toBeLessThan(1);

    // The readout follows the nudges.
    await expect(page.locator('.tool-panel')).toContainText('50%, 45%');
  });

  test('size steppers change one side by one step without moving the centre', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, [PHOTOS[0]]);
    await openTab(page, 'Censor');
    await page.getByRole('button', { name: '+ Blur box' }).click();

    const stage = (await page.locator('.stage-inner').boundingBox())!;
    const region = page.locator('.selection-box').first();
    const start = (await region.boundingBox())!;

    await page.getByRole('button', { name: 'Wider' }).click();
    await page.getByRole('button', { name: 'Shorter' }).click();
    const now = (await region.boundingBox())!;
    expect(Math.abs(now.width - start.width - stage.width * 0.01)).toBeLessThan(1);
    expect(Math.abs(start.height - now.height - stage.height * 0.01)).toBeLessThan(1);
    expect(Math.abs(now.x + now.width / 2 - (start.x + start.width / 2))).toBeLessThan(1);
    expect(Math.abs(now.y + now.height / 2 - (start.y + start.height / 2))).toBeLessThan(1);
  });

  test('deselecting hides every outline so the stage shows the finished result', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, [PHOTOS[0]]);
    await openTab(page, 'Censor');
    await page.getByRole('button', { name: '+ Blur box' }).click();
    await page.getByRole('button', { name: '+ Pixelate box' }).click();

    const outlined = async () =>
      page.locator('.selection-box').evaluateAll((nodes) =>
        nodes.filter((node) => {
          const { borderColor } = getComputedStyle(node);
          return borderColor !== 'rgba(0, 0, 0, 0)' && borderColor !== 'transparent';
        }).length,
      );

    // Only the selected region is outlined, never the others.
    expect(await outlined()).toBe(1);
    await expect(page.locator('.handle')).toHaveCount(1);

    await page.getByRole('button', { name: 'Deselect to preview the result' }).click();
    expect(await outlined()).toBe(0);
    await expect(page.locator('.handle')).toHaveCount(0);
    await expect(page.locator('.tool-panel')).toContainText('Showing the finished result');

    // Tapping a region on the preview picks it up again.
    const first = (await page.locator('.selection-box').first().boundingBox())!;
    await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
    expect(await outlined()).toBe(1);

    // And tapping empty space deselects too.
    const stage = (await page.locator('.stage-inner').boundingBox())!;
    await page.mouse.click(stage.x + 4, stage.y + 4);
    expect(await outlined()).toBe(0);
  });

  test('strength does not change with the size of the region', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, [PHOTOS[0]]);
    await openTab(page, 'Censor');
    await page.getByRole('button', { name: '+ Pixelate box' }).click();
    await page.getByRole('slider', { name: 'Censor strength' }).fill('100');

    // The 640x480 photo is a flat red field with a white square at 40..160 on
    // both axes. Park the region over the square's left and right edges: a
    // block that straddles an edge averages to pink, so the width of a pink
    // run along a row through the region *is* the block size.
    const stage = (await page.locator('.stage-inner').boundingBox())!;
    const region = page.locator('.selection-box').first();
    const rect = (await region.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width * 0.17, stage.y + stage.height * 0.21, { steps: 12 });
    await page.mouse.up();

    const isPink = (r: number, g: number, b: number) => r > 120 && g > 30 && g < 225 && b > 30 && b < 225;
    const blockWidth = (frame: { data: Buffer; width: number; height: number }) => {
      const maxima: number[] = [];
      for (let y = 92; y <= 108; y += 4) {
        let best = 0;
        let run = 0;
        for (let x = 0; x < frame.width; x++) {
          const i = (y * frame.width + x) * 3;
          if (isPink(frame.data[i], frame.data[i + 1], frame.data[i + 2])) run++;
          else run = 0;
          best = Math.max(best, run);
        }
        maxima.push(best);
      }
      return maxima.sort((a, b) => a - b)[Math.floor(maxima.length / 2)];
    };

    // Low quality has no dithering, so pink blocks stay flat and measurable.
    await page.getByRole('slider', { name: 'Censor width' }).fill('30');
    await page.getByRole('slider', { name: 'Censor height' }).fill('30');
    await generate(page, 'Low');
    const small = blockWidth(frameRgb(await readResultGif(page), 0));
    await backToEditor(page);

    await page.getByRole('slider', { name: 'Censor width' }).fill('60');
    await page.getByRole('slider', { name: 'Censor height' }).fill('60');
    await generate(page, 'Low');
    const large = blockWidth(frameRgb(await readResultGif(page), 0));

    // Both are genuinely pixelated, and doubling the region's size leaves the
    // block size where it was. (It used to double with the region.)
    expect(small).toBeGreaterThan(20);
    expect(large).toBeGreaterThan(20);
    expect(Math.abs(large - small)).toBeLessThanOrEqual(Math.max(large, small) * 0.2);
  });
});
