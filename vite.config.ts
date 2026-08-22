import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      // 'prompt', not 'autoUpdate': an activating worker under autoUpdate reloads
      // the tab, and a standalone game lives only in memory — a reload mid-round
      // destroys it.  client/pwa.ts surfaces the update and lets the player pick
      // the moment instead.
      registerType: 'prompt',
      manifest: {
        name: 'Equation Hi-Lo',
        short_name: 'Hi-Lo',
        description:
          'Build equations from the cards you are dealt and bet on landing closest to 1 or to 20.',
        // Relative, never absolute: the site is served from /hilo/ on GitHub
        // Pages and from / on Cloudflare Pages, and these resolve against
        // whichever base the bundle was built with.  An absolute '/' would send
        // the installed app to the wrong origin root on Pages.
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#14141c',
        theme_color: '#14141c',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // The whole app is five hashed files plus icons — precache all of it and
        // there is nothing left to fetch at runtime.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        // Deliberately no runtimeCaching.  The only network calls this app makes
        // are p2pcf signalling and the worker's /turn-creds (p2pcfTransport.ts),
        // both cross-origin and both online-only by definition — a cached TURN
        // credential is an expired one.  Workbox leaves cross-origin requests
        // alone by default; keep it that way.
      },
    }),
  ],
  base: process.env.VITE_BASE_PATH ?? '/hilo/',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
});
