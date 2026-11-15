// Ad hoc screenshots: node e2e/shot.mjs /research/NVDA/overview name [viewport] [theme]
import { BASE, VIEWPORTS, launch, startServer } from './lib.mjs';
const [path = '/', name = 'shot', vp = 'desktop', theme = 'light'] = process.argv.slice(2);
const server = await startServer();
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: VIEWPORTS[vp], colorScheme: theme, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `e2e/out/${name}.png`, fullPage: process.argv[6] !== 'fold' });
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
  server.kill();
  process.exit(0);
}
