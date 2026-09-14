import { expect, test } from '@playwright/test';
import { importPhotos, importVideo, openApp, openTab, PHOTOS } from './helpers';

test.describe('New projects start clean', () => {
  test('starting over drops the previous project\'s edits', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());
    await openApp(page);
    await importVideo(page);

    // Make a mess: an emoji, a censor region, a non-default direction and speed.
    await openTab(page, 'Emoji');
    await page.getByRole('button', { name: 'Add 🔥' }).click();
    // Overlay handles only render while their own tab is open.
    await expect(page.locator('.selection-box')).toHaveCount(1);

    await openTab(page, 'Censor');
    await page.getByRole('button', { name: '+ Blur box' }).click();
    await expect(page.locator('.selection-box')).toHaveCount(1);

    await openTab(page, 'Edit');
    await page.getByRole('button', { name: 'Boomerang' }).click();
    await page.getByRole('slider', { name: 'Playback speed' }).fill('2');
    await expect(page.getByRole('button', { name: 'Boomerang' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('slider', { name: 'Playback speed' })).toHaveValue('2');

    await page.getByLabel('Start over').click();
    await expect(page.getByRole('heading', { level: 2, name: 'GIF Maker' })).toBeVisible();
    await importVideo(page);

    // Direction and speed are per-clip edits, not remembered preferences.
    await openTab(page, 'Edit');
    await expect(page.getByRole('button', { name: 'Forward' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('slider', { name: 'Playback speed' })).toHaveValue('1');

    // And no overlays survived.
    await openTab(page, 'Emoji');
    await expect(page.locator('.tool-panel')).toContainText('Tap an emoji to place it');
    await expect(page.locator('.selection-box')).toHaveCount(0);
    await openTab(page, 'Censor');
    await expect(page.locator('.tool-panel')).toContainText('Add a region');
    await expect(page.locator('.selection-box')).toHaveCount(0);
  });

  test('a fresh project opens on the Edit tab', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());
    await openApp(page);
    await importPhotos(page);
    await expect(page.locator('.tab', { hasText: 'Edit' })).toHaveAttribute('aria-pressed', 'true');

    // Move away, start over, and it should return to Edit rather than remember.
    await openTab(page, 'Frame');
    await page.getByLabel('Start over').click();
    await importPhotos(page);
    await expect(page.locator('.tab', { hasText: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('adding photos to an existing project keeps its edits', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, [PHOTOS[0]]);

    await openTab(page, 'Emoji');
    await page.getByRole('button', { name: 'Add ⭐️' }).click();
    await expect(page.locator('.selection-box')).toHaveCount(1);

    // Appending rather than starting over, so the emoji must survive.
    await openTab(page, 'Edit');
    await page.locator('input[type=file][multiple]').first().setInputFiles([PHOTOS[1]]);
    await expect(page.locator('.strip-item')).toHaveCount(2);
    await expect(page.locator('.stage-meta')).toContainText('1.2s');

    await openTab(page, 'Emoji');
    await expect(page.locator('.selection-box')).toHaveCount(1);
  });
});
