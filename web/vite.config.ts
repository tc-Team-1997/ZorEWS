import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      // SSE stream — EventSource cannot send custom headers, so the proxy
      // injects the required tenant + channel context for local dev.  The
      // default tenant is BANK_DEMO which matches the seed data; change to
      // BIL via .env.development.local if needed.
      '/v1/notifications/stream': {
        target: 'http://localhost:8084',
        changeOrigin: true,
        headers: {
          'X-Tenant-ID': 'BANK_DEMO',
          'X-Channel': 'API',
          'x-apex-role': 'risk_analyst',
        },
      },
      '/api':  { target: 'http://localhost:8084', changeOrigin: true },
      '/v1':   { target: 'http://localhost:8084', changeOrigin: true },
      '/auth': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
});
