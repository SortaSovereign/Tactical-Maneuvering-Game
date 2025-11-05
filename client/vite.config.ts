import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // critical for itch.io & static hosting
  server: { port: 5173, host: true },
  build: { outDir: 'dist' }
});