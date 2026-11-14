/**
 * Owner-only API.
 *
 * Security rules this file enforces and server/app.test.ts proves:
 * - Identity comes only from a signed, HttpOnly session cookie issued after the owner passphrase
 *   check. Client-supplied emails, identity headers, access flags and actors are ignored.
 * - Every state-changing request must come from the configured origin and carry the custom
 *   request header, so a cross-site form or script cannot write.
 * - Workspace writes need If-Match with the revision they were based on. A stale write gets 412
 *   and the current copy. Nothing is overwritten.
 * - Background jobs use a separate token that can only append whitelisted monitor rows. It cannot
 *   read or write the workspace, and the owner session cannot act as a job.
 * - Secrets live in server configuration. No response contains one.
 */
import { Hono, type Context } from 'hono';
import { randomId, safeEqual, signSession, verifyPassphrase, verifySession } from './crypto';
import type { MonitorRow, WorkspaceRepo } from './store';

export interface ServerConfig {
  /** HMAC secret for session cookies. */
  sessionSecret: string;
  /** PBKDF2 record of the owner passphrase, from `hashPassphrase`. */
  ownerPassphraseRecord: string;
  /** Token for background jobs. Different from anything the owner holds. */
  jobToken: string;
  /** Exact origin allowed to write, for example 'https://research.example.com'. */
  allowedOrigin: string;
  /** Clock, injectable for tests. Epoch milliseconds. */
  now?: () => number;
  sessionTtlSec?: number;
  maxBodyBytes?: number;
  /** Failed logins allowed per window before the endpoint refuses for the rest of the window. */
  loginAttempts?: number;
  loginWindowSec?: number;
}

const OWNER = 'owner';
const COOKIE = 'mcl_session';
const MONITOR_TYPES: readonly MonitorRow['type'][] = ['alert', 'forecast', 'source-health'];

const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
};

export const createApp = (repo: WorkspaceRepo, cfg: ServerConfig): Hono => {
  const app = new Hono();
  const now = cfg.now ?? (() => Date.now());
  const ttl = cfg.sessionTtlSec ?? 60 * 60 * 12;
  const maxBody = cfg.maxBodyBytes ?? 512 * 1024;
  const maxAttempts = cfg.loginAttempts ?? 5;
  const windowSec = cfg.loginWindowSec ?? 15 * 60;
  let failures: number[] = [];

  const session = async (c: Context) => verifySession(readCookie(c.req.header('cookie'), COOKIE), cfg.sessionSecret, Math.floor(now() / 1000));

  /** Same-origin and custom-header check for anything that changes state. */
  const sameOriginWrite = (c: Context): boolean => c.req.header('origin') === cfg.allowedOrigin && c.req.header('x-requested-with') === 'mcl';

  const readJson = async (c: Context): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> => {
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > maxBody) return { ok: false, status: 413 };
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > maxBody) return { ok: false, status: 413 };
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, status: 400 };
    }
  };

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  // Public liveness only. No data, no versions, no configuration.
  app.get('/api/health', (c) => c.json({ ok: true }));

  app.post('/api/session', async (c) => {
    if (!sameOriginWrite(c)) return c.json({ error: 'forbidden' }, 403);
    const t = Math.floor(now() / 1000);
    failures = failures.filter((f) => f > t - windowSec);
    if (failures.length >= maxAttempts) return c.json({ error: 'too many attempts' }, 429);
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: 'bad request' }, body.status);
    const pass = (body.value as { passphrase?: unknown } | null)?.passphrase;
    if (typeof pass !== 'string' || !(await verifyPassphrase(pass, cfg.ownerPassphraseRecord))) {
      failures.push(t);
      return c.json({ error: 'unauthorized' }, 401);
    }
    const token = await signSession({ sub: OWNER, exp: t + ttl, jti: randomId() }, cfg.sessionSecret);
    c.header('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`);
    return c.json({ ok: true });
  });

  app.delete('/api/session', (c) => {
    if (!sameOriginWrite(c)) return c.json({ error: 'forbidden' }, 403);
    c.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return c.json({ ok: true });
  });

  app.get('/api/workspace', async (c) => {
    const s = await session(c);
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    const doc = await repo.get(s.sub);
    c.header('ETag', `"${doc?.revision ?? 0}"`);
    return c.json({ revision: doc?.revision ?? 0, updatedAt: doc?.updatedAt ?? null, data: doc?.data ?? null });
  });

  app.put('/api/workspace', async (c) => {
    const s = await session(c);
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    if (!sameOriginWrite(c)) return c.json({ error: 'forbidden' }, 403);
    const ifMatch = c.req.header('if-match');
    const base = ifMatch ? Number(ifMatch.replace(/"/g, '')) : NaN;
    if (!Number.isInteger(base) || base < 0) return c.json({ error: 'If-Match with the base revision is required' }, 428);
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: body.status === 413 ? 'too large' : 'bad request' }, body.status);
    if (typeof body.value !== 'object' || body.value === null || Array.isArray(body.value)) return c.json({ error: 'workspace must be an object' }, 400);
    const out = await repo.put(s.sub, body.value, base, new Date(now()).toISOString());
    if (!out.ok) {
      c.header('ETag', `"${out.current?.revision ?? 0}"`);
      return c.json({ error: 'revision conflict', revision: out.current?.revision ?? 0, data: out.current?.data ?? null }, 412);
    }
    c.header('ETag', `"${out.stored.revision}"`);
    return c.json({ revision: out.stored.revision, updatedAt: out.stored.updatedAt });
  });

  app.get('/api/monitor', async (c) => {
    const s = await session(c);
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ rows: await repo.listMonitor(s.sub) });
  });

  // Background jobs. A separate bearer token, append-only, whitelisted row types, bounded body.
  app.post('/api/jobs/monitor', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !safeEqual(token, cfg.jobToken)) return c.json({ error: 'unauthorized' }, 401);
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: body.status === 413 ? 'too large' : 'bad request' }, body.status);
    const row = body.value as Partial<MonitorRow> | null;
    if (!row || typeof row.key !== 'string' || !row.key || row.key.length > 200 || typeof row.at !== 'string' || !MONITOR_TYPES.includes(row.type as MonitorRow['type'])) {
      return c.json({ error: 'row type or key not allowed' }, 400);
    }
    const res = await repo.appendMonitor(OWNER, { type: row.type as MonitorRow['type'], key: row.key, at: row.at, payload: row.payload ?? null });
    return c.json(res);
  });

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));
  return app;
};
