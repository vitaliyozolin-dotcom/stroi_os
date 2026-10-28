import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { recognitionAssetsPlugin } from './scripts/recognition-assets.mjs';

export default defineConfig({
  plugins: [react(), recognitionAssetsPlugin()],
  build: {
    outDir: 'dist/client',
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: ['terminal.local'],
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
  },
});
