import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import qrcode from 'qrcode-terminal';

/**
 * Prints a QR code for the dev server's LAN address so the app can be opened on
 * a phone by scanning, without typing an IP.
 *
 * It reads Vite's own resolved URL rather than assuming a port, so it stays
 * correct when something else picks the port (PROGRAMS launches this on 4784).
 */
function qrCode(): Plugin {
  return {
    name: 'gif-maker:qr-code',
    apply: 'serve',
    configureServer(server) {
      const printUrls = server.printUrls.bind(server);
      server.printUrls = () => {
        printUrls();
        const url = server.resolvedUrls?.network?.[0] ?? server.resolvedUrls?.local?.[0];
        if (!url) return;
        console.log('');
        qrcode.generate(url, { small: true });
        console.log(`  Scan with the iPhone Camera app (same Wi-Fi): ${url}`);
        // Plain http is not a secure context, so iOS withholds the share sheet
        // and the service worker. Say so rather than let it look broken.
        if (url.startsWith('http://')) {
          console.log('  Note: over http, "Save / Share" and offline support are unavailable.');
          console.log('        Deploy over https for the full installable app.');
        }
        console.log('');
      };
    },
  };
}

export default defineConfig({
  // Relative by default, so the build can be dropped under any path on any
  // static host. GitHub Pages serves a project site from a subdirectory and
  // needs that path spelled out, which the deploy workflow supplies as
  // BASE_PATH=/<repo>/ — an absolute base keeps the service worker's scope and
  // the manifest's start_url unambiguous.
  base: process.env.BASE_PATH || './',
  plugins: [
    react(),
    qrCode(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      manifest: {
        name: 'GIF Maker',
        short_name: 'GIF Maker',
        description: 'Make GIFs from photos and video, entirely on your device.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b0b10',
        theme_color: '#0b0b10',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell is small; precache it all so the editor works offline.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // The HEIC decoder is a ~3MB lazy chunk that iOS Safari never needs
        // (it decodes HEIC natively). Keep it out of the install-time precache
        // and cache it on first use instead.
        globIgnores: ['**/heic-to-*.js'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /heic-to-.*\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'heic-decoder',
              expiration: { maxEntries: 2 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // Large media buffers live in memory, not in the bundle; keep chunks lean.
    chunkSizeWarningLimit: 1200,
  },
  server: { host: true },
  preview: { host: true },
});
