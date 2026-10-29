import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: process.env.EXCALIDRAW_OUT_DIR ?? '../../resources/excalidraw',
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
  },
});
