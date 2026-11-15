import { describe, expect, it } from 'vitest';
import { gate } from './gate';

const env = { APP_PASSWORD: 'correct horse battery' };
const asset = async () => new Response('<html>app</html>', { headers: { 'content-type': 'text/html' } });
const req = (path: string, init?: RequestInit) => new Request(`https://app.example.test${path}`, init);
const login = (password: string, next = '/research/NVDA/overview') =>
  gate(req('/api/login', { method: 'POST', body: new URLSearchParams({ password, next }) }), env, asset);

describe('password gate', () => {
  it('stays closed without a configured password', async () => {
    const r = await gate(req('/'), {}, asset);
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/APP_PASSWORD/);
  });
  it('shows the login page instead of the app and refuses data routes', async () => {
    const page = await gate(req('/research/NVDA/overview'), env, asset);
    expect(page.status).toBe(401);
    const body = await page.text();
    expect(body).toMatch(/type="password"/);
    expect(body).not.toMatch(/app<\/html>/);
    expect(body).toContain('value="/research/NVDA/overview"');
    expect((await gate(req('/api/market/daily?symbol=NVDA'), env, asset)).status).toBe(401);
    expect((await gate(req('/assets/index.js'), env, asset)).status).toBe(401);
  });
  it('rejects a wrong password and a forged cookie', async () => {
    const bad = await login('nope');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    expect((await gate(req('/', { headers: { cookie: 'mcl_session=abc.def' } }), env, asset)).status).toBe(401);
  });
  it('signs in, returns to the page asked for, then serves the app', async () => {
    const ok = await login('correct horse battery');
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/research/NVDA/overview');
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    const page = await gate(req('/research/NVDA/overview', { headers: { cookie: cookie.split(';')[0]! } }), env, asset);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<html>app</html>');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  });
  it('logs everyone out when the password changes', async () => {
    const cookie = (await login('correct horse battery')).headers.get('set-cookie')!.split(';')[0]!;
    const r = await gate(req('/', { headers: { cookie } }), { APP_PASSWORD: 'a different password' }, asset);
    expect(r.status).toBe(401);
  });
  it('never redirects off site after login', async () => {
    for (const next of ['//evil.example', 'https://evil.example', '/api/market/daily']) {
      expect((await login('correct horse battery', next)).headers.get('location')).toBe('/');
    }
  });
});
