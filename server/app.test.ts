import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type ServerConfig } from './app';
import { hashPassphrase, signSession } from './crypto';
import { MemoryRepo } from './store';

const ORIGIN = 'https://research.example.test';
const PASS = 'correct horse battery staple';
let cfg: ServerConfig;
let repo: MemoryRepo;
let app: ReturnType<typeof createApp>;
let clock = Date.parse('2026-11-14T15:00:00Z');

const write = (extra: Record<string, string> = {}) => ({ origin: ORIGIN, 'x-requested-with': 'mcl', 'content-type': 'application/json', ...extra });

const login = async (): Promise<string> => {
  const r = await app.request('/api/session', { method: 'POST', headers: write(), body: JSON.stringify({ passphrase: PASS }) });
  expect(r.status).toBe(200);
  const set = r.headers.get('set-cookie')!;
  expect(set).toMatch(/HttpOnly/);
  expect(set).toMatch(/Secure/);
  expect(set).toMatch(/SameSite=Strict/);
  return set.split(';')[0]!;
};

beforeEach(async () => {
  clock = Date.parse('2026-11-14T15:00:00Z');
  cfg = {
    sessionSecret: 'test-session-secret-not-a-real-secret',
    ownerPassphraseRecord: await hashPassphrase(PASS, 1000),
    jobToken: 'test-job-token',
    allowedOrigin: ORIGIN,
    now: () => clock,
    loginAttempts: 3,
  };
  repo = new MemoryRepo();
  app = createApp(repo, cfg);
});

describe('authorization', () => {
  it('gives an unauthenticated caller nothing', async () => {
    for (const path of ['/api/workspace', '/api/monitor']) {
      const r = await app.request(path);
      expect(r.status).toBe(401);
      expect(await r.text()).not.toMatch(/watchlist|positions|revision/);
    }
    const h = await app.request('/api/health');
    expect(await h.json()).toEqual({ ok: true });
  });

  it('ignores client supplied identity', async () => {
    await repo.put('owner', { positions: [{ symbol: 'ZZZ', shares: 1 }] }, 0, 'now');
    const r = await app.request('/api/workspace', {
      headers: { 'x-user-email': 'owner@example.test', 'x-forwarded-user': 'owner', 'cf-access-authenticated-user-email': 'owner@example.test', authorization: 'Bearer owner', cookie: 'mcl_session=owner; role=owner; actor=owner' },
    });
    expect(r.status).toBe(401);
  });

  it('rejects tampered, foreign and expired sessions', async () => {
    const cookie = await login();
    const tampered = cookie.slice(0, -2) + (cookie.endsWith('A') ? 'B' : 'A') + cookie.slice(-1);
    expect((await app.request('/api/workspace', { headers: { cookie: tampered } })).status).toBe(401);
    const foreign = await signSession({ sub: 'owner', exp: Math.floor(clock / 1000) + 3600, jti: 'x' }, 'another-secret');
    expect((await app.request('/api/workspace', { headers: { cookie: `mcl_session=${foreign}` } })).status).toBe(401);
    expect((await app.request('/api/workspace', { headers: { cookie } })).status).toBe(200);
    clock += 13 * 3600 * 1000;
    expect((await app.request('/api/workspace', { headers: { cookie } })).status).toBe(401);
  });

  it('limits failed logins', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await app.request('/api/session', { method: 'POST', headers: write(), body: JSON.stringify({ passphrase: 'wrong' }) });
      expect(r.status).toBe(401);
    }
    const r = await app.request('/api/session', { method: 'POST', headers: write(), body: JSON.stringify({ passphrase: PASS }) });
    expect(r.status).toBe(429);
  });
});

describe('writes', () => {
  it('requires the configured origin and the custom header', async () => {
    const cookie = await login();
    const body = JSON.stringify({ watchlist: ['AAA'] });
    const cross = await app.request('/api/workspace', { method: 'PUT', headers: { cookie, origin: 'https://evil.example.test', 'x-requested-with': 'mcl', 'if-match': '"0"' }, body });
    expect(cross.status).toBe(403);
    const noHeader = await app.request('/api/workspace', { method: 'PUT', headers: { cookie, origin: ORIGIN, 'if-match': '"0"' }, body });
    expect(noHeader.status).toBe(403);
    const noOrigin = await app.request('/api/workspace', { method: 'PUT', headers: { cookie, 'x-requested-with': 'mcl', 'if-match': '"0"' }, body });
    expect(noOrigin.status).toBe(403);
    expect(await repo.get('owner')).toBeNull();
  });

  it('is compare and swap on the revision', async () => {
    const cookie = await login();
    const put = (rev: number | null, data: unknown) =>
      app.request('/api/workspace', { method: 'PUT', headers: write({ cookie, ...(rev === null ? {} : { 'if-match': `"${rev}"` }) }), body: JSON.stringify(data) });
    expect((await put(null, { a: 1 })).status).toBe(428);
    const first = await put(0, { watchlist: ['AAA'] });
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe('"1"');
    // A second client still on revision 0 must not overwrite revision 1.
    const stale = await put(0, { watchlist: ['BBB'] });
    expect(stale.status).toBe(412);
    const conflict = (await stale.json()) as { revision: number; data: { watchlist: string[] } };
    expect(conflict.revision).toBe(1);
    expect(conflict.data.watchlist).toEqual(['AAA']);
    expect((await put(1, { watchlist: ['AAA', 'BBB'] })).status).toBe(200);
    const read = (await (await app.request('/api/workspace', { headers: { cookie } })).json()) as { revision: number; data: { watchlist: string[] } };
    expect(read.revision).toBe(2);
    expect(read.data.watchlist).toEqual(['AAA', 'BBB']);
  });

  it('bounds the body and rejects malformed documents', async () => {
    const cookie = await login();
    const big = JSON.stringify({ blob: 'x'.repeat(600 * 1024) });
    const r = await app.request('/api/workspace', { method: 'PUT', headers: write({ cookie, 'if-match': '"0"' }), body: big });
    expect(r.status).toBe(413);
    const arr = await app.request('/api/workspace', { method: 'PUT', headers: write({ cookie, 'if-match': '"0"' }), body: '[1,2]' });
    expect(arr.status).toBe(400);
    const bad = await app.request('/api/workspace', { method: 'PUT', headers: write({ cookie, 'if-match': '"0"' }), body: '{not json' });
    expect(bad.status).toBe(400);
  });
});

describe('background jobs', () => {
  const post = (token: string, row: unknown) => app.request('/api/jobs/monitor', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(row) });

  it('uses a separate token that cannot touch the workspace', async () => {
    await repo.put('owner', { positions: [] }, 0, 'now');
    expect((await app.request('/api/workspace', { headers: { authorization: 'Bearer test-job-token' } })).status).toBe(401);
    expect((await app.request('/api/workspace', { method: 'PUT', headers: write({ authorization: 'Bearer test-job-token', 'if-match': '"1"' }), body: '{}' })).status).toBe(401);
    const cookie = await login();
    expect((await post(cookie.split('=')[1]!, { type: 'alert', key: 'k', at: 'now' })).status).toBe(401);
    expect((await post('wrong', { type: 'alert', key: 'k', at: 'now' })).status).toBe(401);
  });

  it('appends only whitelisted rows and never duplicates', async () => {
    const row = { type: 'alert', key: 'us:nvda|2026-11-13|down-session|5', at: '2026-11-13T21:30:00Z', payload: { move: -0.06 } };
    expect(await (await post('test-job-token', row)).json()).toEqual({ inserted: true });
    expect(await (await post('test-job-token', row)).json()).toEqual({ inserted: false });
    expect((await post('test-job-token', { ...row, type: 'workspace' })).status).toBe(400);
    expect((await post('test-job-token', { ...row, key: '' })).status).toBe(400);
    expect((await repo.listMonitor('owner')).length).toBe(1);
  });
});

describe('responses', () => {
  it('never contain a secret and are never cached', async () => {
    const cookie = await login();
    const responses = [await app.request('/api/health'), await app.request('/api/workspace', { headers: { cookie } }), await app.request('/api/nope')];
    for (const r of responses) {
      expect(r.headers.get('cache-control')).toBe('no-store');
      const text = await r.text();
      for (const secret of [cfg.sessionSecret, cfg.jobToken, cfg.ownerPassphraseRecord, PASS]) expect(text).not.toContain(secret);
    }
  });
});
