import { expect, test } from '@playwright/test';
import { generate, importPhotos, importVideo, openApp, openTab } from './helpers';

/** Nothing may overflow horizontally: the editor is an app surface, not a page. */
async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  expect(overflow.doc).toBeLessThanOrEqual(overflow.win + 1);
}

test.describe('Mobile layout', () => {
  test('the whole flow fits an iPhone viewport with usable tap targets', async ({ page }) => {
    await openApp(page);
    await expectNoHorizontalOverflow(page);

    // Import buttons are large targets.
    for (const pick of await page.locator('.pick').all()) {
      const box = (await pick.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }

    await importPhotos(page);
    await expectNoHorizontalOverflow(page);

    // The preview, transport, panel and tab bar all fit without page scroll.
    const layout = await page.evaluate(() => ({
      bodyScroll: document.body.scrollHeight,
      inner: window.innerHeight,
    }));
    expect(layout.bodyScroll).toBeLessThanOrEqual(layout.inner + 2);

    // Tab bar and primary action meet the 44px touch guideline.
    for (const tab of await page.locator('.tab').all()) {
      const box = (await tab.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    // The primary action now lives in the top bar, freeing a row for the preview.
    const cta = (await page.locator('.topbar-cta').boundingBox())!;
    expect(cta.height).toBeGreaterThanOrEqual(36);
    const startOver = (await page.getByLabel('Start over').boundingBox())!;
    expect(startOver.width).toBeGreaterThanOrEqual(36);

    // Every tool panel renders without overflowing.
    for (const tab of ['Edit', 'Emoji', 'Censor', 'Frame']) {
      await openTab(page, tab);
      await expectNoHorizontalOverflow(page);
      await expect(page.locator('.tool-panel')).toBeVisible();
    }

    // The export sheet is reachable and scrollable on a small screen.
    await generate(page);
    await expectNoHorizontalOverflow(page);
    await expect(page.locator('.result-size')).toBeVisible();
  });

  test('editing works through touch taps and drags', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'touch-only path');
    await openApp(page);
    await importPhotos(page);

    await page.locator('.tab', { hasText: 'Emoji' }).tap();
    await page.getByRole('button', { name: 'Add 🔥' }).tap();
    await expect(page.locator('.selection-box')).toHaveCount(1);

    // Drag the sticker with a touch gesture and confirm it actually moved.
    const before = (await page.locator('.selection-box').boundingBox())!;
    const stage = (await page.locator('.stage-inner').boundingBox())!;
    await page.touchscreen.tap(before.x + before.width / 2, before.y + before.height / 2);
    await page.locator('.selection-box').hover();
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width * 0.25, stage.y + stage.height * 0.25, { steps: 10 });
    await page.mouse.up();
    const after = (await page.locator('.selection-box').boundingBox())!;
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(20);
  });

  test('video editing fits the phone viewport too', async ({ page }) => {
    await openApp(page);
    await importVideo(page);
    await openTab(page, 'Edit');
    await expectNoHorizontalOverflow(page);
    await expect(page.locator('.trim-rail')).toBeVisible();
    const grips = await page.locator('.trim-grip').all();
    expect(grips).toHaveLength(2);
    for (const grip of grips) {
      const box = (await grip.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(30);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('PWA', () => {
  test('ships an installable manifest and iOS home-screen metadata', async ({ page }) => {
    await page.goto('/');

    const manifestHref = await page.locator('link[rel=manifest]').getAttribute('href');
    expect(manifestHref).toBeTruthy();
    const manifest = await (await page.request.get(new URL(manifestHref!, page.url()).href)).json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.name).toBe('GIF Maker');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === 'maskable')).toBe(true);

    // iOS Add to Home Screen relies on these specifically.
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"][content="yes"]')).toHaveCount(1);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      'content',
      /viewport-fit=cover/,
    );

    // Icons actually resolve.
    for (const icon of manifest.icons as Array<{ src: string }>) {
      const response = await page.request.get(new URL(icon.src, page.url()).href);
      expect(response.status(), icon.src).toBe(200);
    }
  });

  test('registers a service worker so the editor opens offline', async ({ page }) => {
    await page.goto('/');
    const registered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported';
      const registration = await navigator.serviceWorker.getRegistration();
      return registration ? 'registered' : 'none';
    });
    // WebKit in Playwright does not expose service workers; the metadata test
    // above still covers installability there.
    expect(['registered', 'unsupported']).toContain(registered);
  });
});
