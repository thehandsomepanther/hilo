import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  base: process.env.VITE_BASE_PATH ?? '/hilo/',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
});
