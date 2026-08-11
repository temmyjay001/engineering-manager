import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.EM_API_TARGET ?? 'http://localhost:4788';

export default defineConfig({
  root: 'src/web/ui',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src/web/ui') },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'src/web/assets'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/healthz': { target: apiTarget, changeOrigin: true },
    },
  },
});
