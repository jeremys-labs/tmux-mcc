import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  test: {
    exclude: ['**/e2e/**', '**/node_modules/**'],
    setupFiles: ['./src/test/setup.ts'],
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'MCC',
        short_name: 'MCC',
        description: 'Terminal agent team dashboard',
        theme_color: '#0ea5e9',
        background_color: '#1a1a2e',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: {
        enabled: true,
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            // SSE streams must bypass the service worker entirely
            urlPattern: /\/api\/agent-status\/stream/,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkFirst',
            options: { cacheName: 'api-cache', expiration: { maxEntries: 50, maxAgeSeconds: 300 } },
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 3001,
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': 'http://localhost:8083',
      '/ws': { target: 'ws://localhost:8083', ws: true },
    },
  },
});
