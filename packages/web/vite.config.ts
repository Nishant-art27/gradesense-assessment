import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@gradesense/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    // The API runs separately; proxying keeps the browser on one origin so
    // there is no CORS story to think about in development.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
