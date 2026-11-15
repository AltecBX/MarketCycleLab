import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { handleMarket } from './server/market.ts';

/** Serves `/api/market/*` from the dev and preview servers. Provider access stays on this side. */
const marketApi = (): Plugin => {
  const mount = (server: { middlewares: { use: (fn: (req: { url?: string }, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b: string) => void }, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/market/')) return next();
      handleMarket(url, { UW_API_KEY: process.env.UW_API_KEY }).then(async (r) => {
        if (!r) return next();
        res.statusCode = r.status;
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(await r.text());
      }, next);
    });
  };
  return { name: 'market-api', configureServer: mount, configurePreviewServer: mount };
};

export default defineConfig({
  plugins: [react(), marketApi()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { react: ['react', 'react-dom', 'react-router-dom'] },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    testTimeout: 30000,
  },
});
