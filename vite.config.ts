import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative base so the built app can be dropped under any path
  // (GitHub Pages project sites, a subfolder on a static host, file previews).
  base: './',
  plugins: [
    react(),
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
