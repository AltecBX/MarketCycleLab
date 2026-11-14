/**
 * Local server entry: `node --experimental-strip-types server/dev.ts`.
 * Reads every secret from the environment. Refuses to start when one is missing.
 * Generate the passphrase record with: node --experimental-strip-types server/hash.ts
 */
import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { MemoryRepo } from './store.ts';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
};

const app = createApp(new MemoryRepo(), {
  sessionSecret: need('MCL_SESSION_SECRET'),
  ownerPassphraseRecord: need('MCL_OWNER_PASSPHRASE_RECORD'),
  jobToken: need('MCL_JOB_TOKEN'),
  allowedOrigin: need('MCL_ALLOWED_ORIGIN'),
});

const port = Number(process.env.PORT ?? 8787);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const method = req.method ?? 'GET';
  const r = await app.fetch(new Request(`http://localhost:${port}${req.url}`, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks) }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`API listening on ${port}`));
