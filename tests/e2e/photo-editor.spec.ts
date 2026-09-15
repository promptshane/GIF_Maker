import { expect, test } from '@playwright/test';
import { PHOTOS } from './helpers';

test.describe('Photo editor', () => {
  test('chooses a photo workflow, censors, aligns, previews quality and exports JPEG', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Edit Photo' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Photo Editor' })).toBeVisible();

    await page.locator('input[type=file][accept^="image"]').setInputFiles(PHOTOS[0]);
    await expect(page.getByRole('button', { name: 'Save Photo' })).toBeVisible();

    await page.getByRole('button', { name: '+ Black bar' }).click();
    await page.getByRole('button', { name: 'Duplicate region 1' }).click();
    await expect(page.locator('.selection-box.censor')).toHaveCount(2);

    // Duplicates start 4% down and right. Four nudges align each centre and
    // trigger the matching-size alignment guides.
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Nudge left' }).click();
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Nudge up' }).click();
    await expect(page.locator('.alignment-guide')).toHaveCount(2);

    await page.locator('.tab', { hasText: 'Quality' }).click();
    await page.getByRole('slider', { name: 'Photo quality' }).fill('20');
    await expect(page.locator('.photo-quality-readout')).toContainText('241 × 180');

    await page.getByRole('button', { name: 'Save Photo' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const preview = page.getByRole('img', { name: 'Edited photo export preview' });
    await expect(preview).toBeVisible();
    const info = await preview.evaluate(async (image: HTMLImageElement) => {
      const response = await fetch(image.src);
      const blob = await response.blob();
      return { type: blob.type, width: image.naturalWidth, height: image.naturalHeight };
    });
    expect(info).toEqual({ type: 'image/jpeg', width: 241, height: 180 });

    // Still-photo projects are saved separately from GIF projects and reopen
    // directly in the photo editor with their quality and censor edits intact.
    await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });
    await page.getByRole('button', { name: /Save project/ }).click();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Redacted photo');
    await page.getByRole('dialog').getByRole('button', { name: /^Save/ }).click();
    await expect(page.locator('.topbar-save')).toHaveText('Saved');

    page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Start over' }).click();
    const saved = page.locator('.project-row', { hasText: 'Redacted photo' });
    await expect(saved).toContainText('Edited photo');
    await page.getByRole('button', { name: 'Open Redacted photo' }).click();
    await expect(page.getByRole('button', { name: 'Save Photo' })).toBeVisible();
    await page.locator('.tab', { hasText: 'Quality' }).click();
    await expect(page.getByRole('slider', { name: 'Photo quality' })).toHaveValue('20');
    await page.locator('.tab', { hasText: 'Censor' }).click();
    await expect(page.locator('.selection-box.censor')).toHaveCount(2);
  });
});
