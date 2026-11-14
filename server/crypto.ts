/** Web Crypto helpers. They run unchanged on Node 20+ and on edge runtimes. */

const enc = new TextEncoder();

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64url = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/** Constant-time comparison of two strings of equal expected length. */
export const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export interface SessionClaims {
  /** Subject. Always the single owner id. Never taken from the client. */
  sub: string;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Random id so a session can be told apart in logs without exposing the token. */
  jti: string;
}

/** Signed session token: base64url(payload).base64url(HMAC-SHA256(payload)). */
export const signSession = async (claims: SessionClaims, secret: string): Promise<string> => {
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
};

export const verifySession = async (token: string | undefined, secret: string, nowSec: number): Promise<SessionClaims | null> => {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig) as BufferSource, enc.encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as SessionClaims;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || claims.exp <= nowSec) return null;
    return claims;
  } catch {
    return null;
  }
};

/** PBKDF2-SHA256 passphrase record, 'iterations:salt:hash' with base64url parts. */
export const hashPassphrase = async (passphrase: string, iterations = 310_000): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `${iterations}:${b64url(salt)}:${b64url(bits)}`;
};

export const verifyPassphrase = async (passphrase: string, record: string): Promise<boolean> => {
  const [iterS, saltS, hashS] = record.split(':');
  const iterations = Number(iterS);
  if (!iterations || !saltS || !hashS) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64url(saltS) as BufferSource, iterations }, key, 256);
  return safeEqual(b64url(bits), hashS);
};

export const randomId = (): string => b64url(crypto.getRandomValues(new Uint8Array(12)));
