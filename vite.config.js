import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  root: 'frontend',
  plugins: [svelte()],
  build: { outDir: '../web', emptyOutDir: true },
});
