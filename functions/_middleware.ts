/**
 * Cloudflare Pages entry. Runs for every request: the password gate, the market data routes,
 * then the static app. Environment variables: APP_PASSWORD (required), UW_API_KEY (earnings).
 */
import { gate, type GateEnv } from '../server/gate';

interface PagesContext {
  request: Request;
  env: GateEnv;
  next: () => Promise<Response>;
}

export const onRequest = (ctx: PagesContext): Promise<Response> => gate(ctx.request, ctx.env, () => ctx.next());
