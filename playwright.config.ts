import { defineConfig, devices } from '@playwright/test';

/**
 * The suite runs against the production build, because that is what a phone
 * loads: the module worker, the code-split chunks and the service worker only
 * exist there.
 *
 * WebKit is the primary target (it is the engine behind iOS Safari), at an
 * iPhone-sized viewport. Chromium runs the same specs as a cross-engine check.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'iphone-webkit',
      use: {
        ...devices['iPhone 13'],
        // Playwright's WebKit build is desktop-flavoured; isMobile/touch are
        // what actually exercise the touch paths.
        browserName: 'webkit',
      },
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
