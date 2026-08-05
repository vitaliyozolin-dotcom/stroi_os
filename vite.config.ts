import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
