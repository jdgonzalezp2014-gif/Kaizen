import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: {
    // `wrangler pages dev` serves the Functions; Vite proxies /api to it so
    // local dev exercises the real server code rather than a mock.
    proxy: { '/api': 'http://127.0.0.1:8788' }
  }
});
