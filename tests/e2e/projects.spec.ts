import { expect, test as base, webkit, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  frameDifference, frameRgb, generate, importPhotos, importVideo, openApp, openTab, PHOTOS, probeGif,
  readResultGif,
} from './helpers';

/**
 * Saved projects keep media as Blobs in IndexedDB. WebKit's *in-memory*
 * IndexedDB — what Playwright's default ephemeral context gets, and what
 * Safari uses for Private Browsing — cannot store Blobs at all, so on WebKit
 * this suite runs in a persistent context, which is what real Safari and the
 * installed app use. Chromium is unaffected.
 */
const test = base.extend<{ context: BrowserContext }>({
  context: async ({ context, browserName }, use, testInfo) => {
    if (browserName !== 'webkit') {
      await use(context);
      return;
    }
    const opts = testInfo.project.use;
    const persistent = await webkit.launchPersistentContext(mkdtempSync(join(tmpdir(), 'gifmaker-wk-')), {
      baseURL: opts.baseURL,
      viewport: opts.viewport,
      deviceScaleFactor: opts.deviceScaleFactor,
      isMobile: opts.isMobile,
      hasTouch: opts.hasTouch,
      userAgent: opts.userAgent,
    });
    await use(persistent);
    await persistent.close();
  },
});

async function saveAs(page: Page, name: string) {
  await page.getByRole('button', { name: /Save project/ }).click();
  const field = page.getByRole('textbox', { name: 'Project name' });
  await field.fill(name);
  await page.getByRole('dialog').getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.busy-veil')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('.topbar-save')).toHaveText('Saved');
}

async function closeSheet(page: Page) {
  await page.getByRole('button', { name: 'Change quality and regenerate' }).click();
  await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });
}

test.describe('Saved projects', () => {
  test('a video project reopens with every edit intact and exports the same GIF', async ({ page }) => {
    await openApp(page);
    await importVideo(page);

    // Make a distinctive project: 10 FPS, 2x, a censor box moved off-centre.
    await openTab(page, 'Edit');
    await page.getByRole('button', { name: '10', exact: true }).click();
    await page.getByRole('slider', { name: 'Playback speed' }).fill('2');
    await openTab(page, 'Censor');
    await page.getByRole('button', { name: '+ Pixelate box' }).click();
    await page.getByRole('slider', { name: 'Censor strength' }).fill('80');
    for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Nudge left' }).click();
    await expect(page.locator('.tool-panel')).toContainText('45%, 45%');

    // Not yet saved: the button invites a save and no "unsaved" state exists.
    await expect(page.locator('.topbar-save')).toHaveText('Save');
    await expect(page.locator('.topbar-save')).not.toHaveClass(/dirty/);
    await saveAs(page, 'Nudged clip');

    // An edit after saving is flagged; undoing it exactly clears the flag.
    await page.getByRole('button', { name: 'Nudge right' }).click();
    await expect(page.locator('.topbar-save')).toHaveText('Save');
    await expect(page.locator('.topbar-save')).toHaveClass(/dirty/);
    await page.getByRole('button', { name: 'Nudge left' }).click();
    await expect(page.locator('.topbar-save')).toHaveText('Saved');

    // A real change, saved in place under the same name.
    await page.getByRole('button', { name: 'Nudge right' }).click();
    await expect(page.locator('.topbar-save')).toHaveClass(/dirty/);
    await page.getByRole('button', { name: /Save project/ }).click();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Nudged clip');
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.topbar-save')).toHaveText('Saved', { timeout: 60_000 });
    await expect(page.locator('.tool-panel')).toContainText('46%, 45%');

    await generate(page);
    const beforeBytes = await readResultGif(page);
    const before = probeGif(beforeBytes);
    await closeSheet(page);

    // Come back later: a fresh page load, then open it from the home screen.
    await page.reload();
    await expect(page.getByRole('heading', { level: 2, name: 'GIF Maker' })).toBeVisible();
    const row = page.locator('.project-row', { hasText: 'Nudged clip' });
    await expect(row).toContainText('Video');
    await expect(row).toHaveCount(1);
    await page.getByRole('button', { name: 'Open Nudged clip' }).click();
    await expect(page.getByRole('button', { name: 'Export GIF' })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.busy-veil')).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('.topbar-save')).toHaveText('Saved');

    // Every edit is back, still editable.
    await openTab(page, 'Edit');
    await expect(page.getByRole('button', { name: '10', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('slider', { name: 'Playback speed' })).toHaveValue('2');
    await openTab(page, 'Censor');
    await expect(page.locator('.tool-panel')).toContainText('1. Pixelate box');
    await expect(page.locator('.tool-panel')).toContainText('46%, 45%');
    await expect(page.locator('.tool-panel')).toContainText('80%');
    await expect(page.locator('.selection-box.censor')).toHaveCount(1);

    // And the output is the same GIF.
    await generate(page);
    const afterBytes = await readResultGif(page);
    const after = probeGif(afterBytes);
    expect(after.frames).toBe(before.frames);
    expect(after.width).toBe(before.width);
    const mid = Math.floor(before.frames / 2);
    expect(frameDifference(frameRgb(beforeBytes, mid).data, frameRgb(afterBytes, mid).data)).toBeLessThan(1);
  });

  test('a photo project keeps order, durations and duplicates, and can be deleted', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, [PHOTOS[0], PHOTOS[1]]);
    await openTab(page, 'Edit');

    // Photo 1 at 0.3s, photo 2 duplicated and set to 1s.
    await page.getByRole('button', { name: /^Photo 1,/ }).click();
    await page.getByRole('button', { name: '0.3s', exact: true }).click();
    await page.getByRole('button', { name: /^Photo 2,/ }).click();
    await page.getByRole('button', { name: 'Duplicate photo' }).click();
    await page.getByRole('button', { name: /^Photo 3,/ }).click();
    await page.getByRole('button', { name: '1s', exact: true }).click();
    await expect(page.locator('.strip-item')).toHaveCount(3);

    await saveAs(page, 'Three frames');
    await page.reload();
    await expect(page.getByRole('heading', { level: 2, name: 'GIF Maker' })).toBeVisible();
    const row = page.locator('.project-row', { hasText: 'Three frames' });
    await expect(row).toContainText('3 photos');
    await page.getByRole('button', { name: 'Open Three frames' }).click();
    await expect(page.getByRole('button', { name: 'Export GIF' })).toBeVisible({ timeout: 60_000 });

    const items = page.locator('.strip-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('0.30s');
    await expect(items.nth(1)).toContainText('0.60s');
    await expect(items.nth(2)).toContainText('1.00s');

    // Delete it from the home screen.
    page.on('dialog', (dialog) => dialog.accept());
    await page.getByLabel('Start over').click();
    await expect(row).toBeVisible();
    await page.getByRole('button', { name: 'Delete Three frames' }).click();
    await expect(row).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 2, name: 'GIF Maker' })).toBeVisible();
    await expect(page.locator('.project-row', { hasText: 'Three frames' })).toHaveCount(0);
  });

  test('starting over from a saved project keeps it saved', async ({ page }) => {
    await openApp(page);
    await importPhotos(page, [PHOTOS[2]]);
    await saveAs(page, 'Keep me');

    page.on('dialog', (dialog) => {
      expect(dialog.message()).toContain('stays saved');
      void dialog.accept();
    });
    await page.getByLabel('Start over').click();
    await expect(page.locator('.project-row', { hasText: 'Keep me' })).toBeVisible();
  });
});

// The default ephemeral context is WebKit's in-memory store: the same thing
// Safari gives Private Browsing, where Blobs cannot be stored at all.
base.describe('Saved projects in Private Browsing', () => {
  base('explains that projects cannot be kept, rather than failing silently', async ({ page, browserName }) => {
    base.skip(browserName !== 'webkit', 'Only WebKit has an in-memory IndexedDB without Blob support');
    await openApp(page);
    await importPhotos(page, [PHOTOS[0]]);
    await page.getByRole('button', { name: /Save project/ }).click();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Private');
    await page.getByRole('dialog').getByRole('button', { name: /^Save/ }).click();
    await expect(page.getByRole('alert')).toContainText('Private Browsing');
    await expect(page.locator('.topbar-save')).toHaveText('Save');
  });
});
