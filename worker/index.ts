/**
 * Cloudflare Workers entry. Every request, including the page and its files, passes the password
 * gate first. The market data routes run here. Static files come from the ASSETS binding.
 * Secrets: APP_PASSWORD (required), UW_API_KEY (earnings). Set them under Settings, Variables
 * and Secrets, as type Secret.
 */
import { gate, type GateEnv } from '../server/gate';

interface Env extends GateEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return gate(request, env, () => env.ASSETS.fetch(request));
  },
};
