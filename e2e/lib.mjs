// Shared helpers for browser checks. Serves the production build with `vite preview`.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = process.env.PORT ?? '4173';
const DIST = process.env.DIST ?? 'dist';
export const BASE = `http://127.0.0.1:${PORT}`;

/** Build into DIST when BUILD=1, then serve it. Set PORT and DIST to run several checks side by side. */
export async function startServer() {
  if (process.env.BUILD === '1') {
    const b = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'], { stdio: 'inherit' });
    if (b.status !== 0) throw new Error('build failed');
  }
  const proc = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', DIST, '--port', PORT, '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return proc;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error('preview server did not start');
}

export async function launch() {
  return chromium.launch();
}

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1180, height: 760 },
  phoneMax: { width: 440, height: 956 },
  phone: { width: 390, height: 844 },
  narrow: { width: 320, height: 640 },
};

/** True when the document scrolls sideways at the current viewport. */
export async function hasPageSideScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}
