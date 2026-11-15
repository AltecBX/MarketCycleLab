// Live data sweep against a running `npm run dev:live` on port 5173. Not part of CI: it calls real providers.
import { VIEWPORTS, hasPageSideScroll, launch } from './lib.mjs';
const BASE = process.env.LIVE_BASE ?? 'http://127.0.0.1:5173';
const ROUTES = [
  '/', '/data',
  ...['overview', 'selloffs', 'selloffs?tab=declines', 'selloffs?tab=monthly', 'trend', 'calendar', 'calendar?view=weekly', 'strength', 'earnings', 'business', 'forecasts', 'forecasts?tab=range', 'lab'].map((s) => `/research/NVDA/${s}`),
  '/research/SNDK/overview', '/research/SPY/earnings', '/research/PLTR/overview',
  '/discover', '/discover/groups', '/discover/drawdowns', '/discover/cash', '/discover/earnings',
  '/portfolio', '/portfolio/protection', '/portfolio/journal',
];
const failures = [];
const browser = await launch();
for (const vp of ['desktop', 'phone']) {
  const page = await browser.newPage({ viewport: VIEWPORTS[vp] });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  for (const r of ROUTES) {
    errors.length = 0;
    await page.goto(BASE + r, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(r.startsWith('/discover') ? 2500 : 1200);
    const text = await page.evaluate(() => document.getElementById('main')?.innerText ?? '');
    const note = [];
    if (await hasPageSideScroll(page)) note.push('side scroll');
    if (errors.length) note.push(`error: ${errors[0].slice(0, 160)}`);
    if (/\bNaN\b|undefined|\[object Object\]/.test(text)) note.push('broken text');
    if (/could not be displayed|is being built/.test(text)) note.push('card failure');
    if (note.length) { failures.push(`${vp} ${r}: ${note.join('; ')}`); console.log('FAIL', vp, r, note.join('; ')); }
  }
  await page.close();
}
await browser.close();
console.log(failures.length ? `${failures.length} live issue(s)` : 'Live sweep clean');
process.exit(failures.length ? 1 : 0);
