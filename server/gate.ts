/**
 * Password gate for the hosted app. Every request, including the page itself, needs a valid
 * session cookie. The only secret is APP_PASSWORD, set in the host's environment settings.
 * Market data routes run behind the gate, so provider data is never served to anyone else.
 */
import { randomId, safeEqual, signSession, verifySession } from './crypto.ts';
import { handleMarket } from './market.ts';

export interface GateEnv {
  APP_PASSWORD?: string;
  UW_API_KEY?: string;
}

const COOKIE = 'mcl_session';
const TTL_SEC = 30 * 24 * 60 * 60;

const SECURITY_HEADERS: Record<string, string> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const withHeaders = (r: Response, extra: Record<string, string> = {}): Response => {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v);
  return out;
};

const readCookie = (header: string | null, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
};

const sessionKey = (password: string): string => `mcl-session:${password}`;

const safeNext = (n: string | null): string => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/api/') ? n : '/');

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const loginPage = (next: string, message: string | null): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Market Cycle Research</title><link rel="icon" href="/mark.svg">
<style>
:root{--bg:#f5f6f8;--card:#fff;--text:#101826;--muted:#465264;--line:#b9c2cd;--accent:#0e7490;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0a0e13;--card:#121820;--text:#e9eef4;--muted:#b3bdc9;--line:#41506a;--accent:#45d1c4;--err:#ff8177}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",Roboto,sans-serif;padding:16px}
form{width:min(360px,100%);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;display:grid;gap:14px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700}.brand img{width:30px;height:30px}
label{display:grid;gap:6px;color:var(--muted);font-size:13px}
input{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:9px;padding:11px 12px;min-height:44px}
button{font:inherit;font-weight:650;border:0;border-radius:9px;min-height:44px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:var(--err);font-size:13px;margin:0}
</style></head><body>
<form method="post" action="/api/login">
<div class="brand"><img src="/mark.svg" alt=""><span>Market Cycle Research</span></div>
<label>Password<input name="password" type="password" autocomplete="current-password" autofocus required></label>
<input type="hidden" name="next" value="${esc(next)}">
${message ? `<p class="err" role="alert">${esc(message)}</p>` : ''}
<button type="submit">Open</button>
</form></body></html>`;

const html = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

/**
 * Handle one request. `serveAsset` returns the static file (the host's asset handler).
 * Returns the response to send.
 */
export const gate = async (request: Request, env: GateEnv, serveAsset: () => Promise<Response>, nowMs = Date.now()): Promise<Response> => {
  const url = new URL(request.url);
  const password = env.APP_PASSWORD ?? '';
  if (password.length < 8) {
    return withHeaders(html(`<!doctype html><meta charset="utf-8"><title>Setup needed</title><body style="font-family:system-ui;padding:24px;max-width:560px">
<h1 style="font-size:20px">One more setup step</h1><p>Add an environment variable named <b>APP_PASSWORD</b> (8 characters or more) in your hosting settings, then redeploy. The app stays closed until it is set.</p></body>`, 503));
  }
  // Static brand assets used by the login page are public. Nothing else is.
  if (url.pathname === '/mark.svg') return withHeaders(await serveAsset());

  if (url.pathname === '/api/login' && request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const given = String(form?.get('password') ?? '');
    const next = safeNext(String(form?.get('next') ?? '/'));
    if (!safeEqual(given, password)) {
      await new Promise((r) => setTimeout(r, 600));
      return withHeaders(html(loginPage(next, 'That password is not correct.'), 401));
    }
    const token = await signSession({ sub: 'owner', exp: Math.floor(nowMs / 1000) + TTL_SEC, jti: randomId() }, sessionKey(password));
    return withHeaders(new Response(null, { status: 303, headers: { location: next, 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_SEC}` } }));
  }
  if (url.pathname === '/api/logout') {
    return withHeaders(new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } }));
  }

  const session = await verifySession(readCookie(request.headers.get('cookie'), COOKIE), sessionKey(password), Math.floor(nowMs / 1000));
  if (!session) {
    if (url.pathname.startsWith('/api/')) return withHeaders(new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    return withHeaders(html(loginPage(safeNext(url.pathname + url.search), null), 401));
  }

  if (url.pathname.startsWith('/api/market/')) {
    const r = await handleMarket(url, { UW_API_KEY: env.UW_API_KEY });
    return withHeaders(r ?? new Response('{"error":"not found"}', { status: 404 }));
  }
  if (url.pathname.startsWith('/api/')) return withHeaders(new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }));
  return withHeaders(await serveAsset(), { 'cache-control': url.pathname.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'no-store' });
};
