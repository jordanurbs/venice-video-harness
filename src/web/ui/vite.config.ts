import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev mode proxies API + media to the harness server (venice-video web).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/media': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
