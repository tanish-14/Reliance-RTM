import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const api = { '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true } };

export default defineConfig({
  resolve: {
    // Use the shared package's TypeScript source so device and server run the same engine.
    alias: { '@rtm/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'RCPL Route-to-Market',
        short_name: 'RCPL RTM',
        description: 'Field sales, distribution and retail ordering for RCPL',
        theme_color: '#b91c1c',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell is precached; API data lives in IndexedDB, never in the SW cache.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api },
});
