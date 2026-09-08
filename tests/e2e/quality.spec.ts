import { expect, test } from '@playwright/test';
import {
  generate, importPhotos, importVideo, openApp, openTab, probeGif, readResultGif,
} from './helpers';

async function regenerateAgain(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Change quality and regenerate' }).click();
  await expect(page.getByRole('button', { name: 'Generate GIF' })).toBeVisible();
}

test.describe('Export quality', () => {
  test('each preset produces a genuinely different file, in size order', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Timing');
    await page.getByRole('button', { name: '10', exact: true }).click();

    const results: Array<{ label: string; bytes: number; frames: number; w: number; h: number }> = [];
    for (const label of ['Low', 'Medium', 'High', 'Extra High'] as const) {
      if (results.length > 0) await regenerateAgain(page);
      await generate(page, label);
      const info = probeGif(await readResultGif(page));
      results.push({ label, bytes: info.bytes, frames: info.frames, w: info.width, h: info.height });
    }

    // Size rises with quality...
    for (let i = 1; i < results.length; i++) {
      expect(results[i].bytes, `${results[i].label} vs ${results[i - 1].label}`)
        .toBeGreaterThan(results[i - 1].bytes);
    }
    expect(results[3].bytes).toBeGreaterThan(results[0].bytes * 1.3);

    // ...while dimensions, frame rate and duration are untouched by the preset.
    for (const result of results) {
      expect(result.frames).toBe(results[0].frames);
      expect(result.w).toBe(results[0].w);
      expect(result.h).toBe(results[0].h);
    }
  });

  test('the exact size is shown, and updates when quality changes', async ({ page }) => {
    await openApp(page);
    await importPhotos(page);

    await generate(page, 'Extra High');
    const highBytes = probeGif(await readResultGif(page)).bytes;
    const highShown = await page.locator('.result-size').innerText();

    // The result card reports the settings that produced the file.
    await expect(page.locator('.result-card')).toContainText('Extra High quality');
    await expect(page.locator('.result-grid')).toContainText('15 FPS');
    await expect(page.locator('.result-grid')).toContainText('1.8s');

    await regenerateAgain(page);
    await generate(page, 'Low');
    const lowBytes = probeGif(await readResultGif(page)).bytes;
    const lowShown = await page.locator('.result-size').innerText();

    expect(lowBytes).toBeLessThan(highBytes);
    expect(lowShown).not.toBe(highShown);
    await expect(page.locator('.result-card')).toContainText('Low quality');

    const parse = (text: string) => {
      const value = Number(text.replace(/[^\d.]/g, ''));
      return text.includes('MB') ? value * 1024 * 1024 : value * 1024;
    };
    expect(Math.abs(parse(lowShown) - lowBytes)).toBeLessThan(120);
    expect(Math.abs(parse(highShown) - highBytes)).toBeLessThan(120);
  });

  test('the pre-encode estimate lands near the real size', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Timing');
    await page.getByRole('button', { name: '10', exact: true }).click();

    await page.getByRole('button', { name: 'Export GIF' }).click();
    await page.locator('.quality-opt', { hasText: 'Medium' }).first().click();
    await page.getByRole('button', { name: 'Estimate size first' }).click();
    await expect(page.locator('.sheet')).toContainText('Estimated size', { timeout: 60_000 });

    const text = await page.locator('.sheet').innerText();
    const range = text.match(/Estimated size:\s*([\d.]+)\s*(KB|MB)\s*–\s*([\d.]+)\s*(KB|MB)/);
    expect(range).not.toBeNull();
    const toBytes = (n: string, unit: string) =>
      Number(n) * (unit === 'MB' ? 1024 * 1024 : 1024);
    const low = toBytes(range![1], range![2]);
    const high = toBytes(range![3], range![4]);

    await page.getByRole('button', { name: 'Generate GIF' }).click();
    await expect(page.locator('.result-size')).toBeVisible({ timeout: 120_000 });
    const actual = probeGif(await readResultGif(page)).bytes;

    // The estimate is measured by really encoding a sample, so it should
    // bracket the true size rather than be a guess.
    expect(low).toBeLessThan(actual * 1.35);
    expect(high).toBeGreaterThan(actual * 0.7);
  });
});
