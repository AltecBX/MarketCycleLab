// Browser acceptance checks against the production build. Run with `npm run e2e` after `npm run build`.
import { BASE, VIEWPORTS, hasPageSideScroll, launch, startServer } from './lib.mjs';

const ROUTES = [
  '/', '/data',
  ...['overview', 'selloffs', 'selloffs?tab=declines', 'selloffs?tab=monthly', 'trend', 'calendar', 'calendar?view=weekly', 'strength', 'earnings', 'business', 'forecasts', 'forecasts?tab=range', 'lab'].map((s) => `/research/NVDA/${s}`),
  '/research/SNDK/overview', '/research/SPY/earnings',
  '/discover', '/discover?cap=10', '/discover/groups', '/discover/drawdowns', '/discover/cash', '/discover/earnings',
  '/portfolio', '/portfolio/protection', '/portfolio/journal',
];
const failures = [];
const fail = (m) => { failures.push(m); console.log('FAIL', m); };
const server = await startServer();
const browser = await launch();
try {
  // 1. Every route at desktop, 440, 390 and 320: no page side scroll, no errors, no broken text.
  for (const vp of ['desktop', 'phoneMax', 'phone', 'narrow']) {
    const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], colorScheme: vp === 'phone' ? 'dark' : 'light' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    for (const r of ROUTES) {
      errors.length = 0;
      await page.goto(BASE + r, { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      const text = await page.evaluate(() => document.getElementById('main')?.innerText ?? '');
      if (await hasPageSideScroll(page)) fail(`${vp} ${r}: page scrolls sideways`);
      if (errors.length) fail(`${vp} ${r}: ${errors[0]}`);
      if (/\bNaN\b|undefined|\[object Object\]/.test(text)) fail(`${vp} ${r}: broken text`);
      if (/could not be displayed|is being built/.test(text)) fail(`${vp} ${r}: card failure or placeholder`);
    }
    await ctx.close();
  }
  // 2. Symbol switching: the strip never shows another symbol's name, aliases resolve, unknown symbols explain.
  const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
  for (const s of ['NVDA', 'MU', 'SNDK', 'INTC', 'LLY', 'SPY', 'AAOI']) {
    await page.goto(`${BASE}/research/${s}/overview`, { waitUntil: 'networkidle' });
    const pill = (await page.locator('.ticker-pill').first().innerText()).trim();
    if (pill !== s) fail(`switch ${s}: pill shows ${pill}`);
  }
  await page.goto(`${BASE}/research/CCCX/overview`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  if (!page.url().includes('/research/INFQ/')) fail('alias CCCX did not resolve to INFQ');
  await page.goto(`${BASE}/research/ZZZZ/overview`, { waitUntil: 'networkidle' });
  if (!/cannot be opened/.test(await page.locator('#main').innerText())) fail('unknown symbol has no explanation');
  await page.goto(`${BASE}/research/INTC/overview`, { waitUntil: 'networkidle' });
  if ((await page.locator('[data-logo="ticker-badge"]').count()) < 1) fail('INTC does not show the honest ticker badge');
  // 3. Rapid switching ends on the last symbol with its own figures.
  await page.goto(`${BASE}/research/NVDA/overview`);
  for (const s of ['MU', 'ZZZZ', 'SNDK', 'LLY']) await page.evaluate((p) => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, `/research/${s}/overview`);
  await page.waitForTimeout(1200);
  const strip = await page.locator('section.card').first().innerText();
  if (!strip.includes('LLY') || !strip.includes('Eli Lilly')) fail('rapid switch did not settle on LLY');
  // 4. Search by keyboard.
  await page.keyboard.press('/');
  await page.keyboard.type('micron');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  if (!page.url().includes('/research/MU/')) fail('keyboard search did not open MU');
  // 5. Source outage is scoped and recoverable.
  await page.goto(`${BASE}/data`, { waitUntil: 'networkidle' });
  await page.evaluate(() => sessionStorage.setItem('mcl.fixture.outage', '["earnings"]'));
  await page.goto(`${BASE}/research/NVDA/overview`, { waitUntil: 'networkidle' });
  const t = await page.locator('section.card').first().innerText();
  if (!/Source failed/.test(t)) fail('earnings outage not shown in strip');
  if (!/\$\d/.test(t)) fail('price disappeared during an earnings outage');
  await page.evaluate(() => sessionStorage.removeItem('mcl.fixture.outage'));
  // 6. Legacy links land somewhere real.
  for (const [from, want] of [['/big-declines', '/selloffs'], ['/stock-screener', '/discover'], ['/my-portfolio', '/portfolio']]) {
    await page.goto(BASE + from, { waitUntil: 'networkidle' });
    if (!page.url().includes(want)) fail(`legacy ${from} did not redirect to ${want}`);
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(failures.length ? `${failures.length} failure(s)` : 'All browser checks passed');
process.exit(failures.length ? 1 : 0);
