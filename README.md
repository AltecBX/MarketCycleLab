# Market Cycle Research

Evidence-led research on stock selloffs, trends and positions. A rebuild of the owner's private
Study Market Drawdown Patterns app, written from the owner specification.

## Use it

The app is a private web page. Open your bookmark, enter your password, and it works on desktop
and iPhone. Every push to `main` redeploys it automatically.

Data sources:
- Daily prices and fundamentals: Yahoo Finance, free, completed sessions only.
- Earnings dates and results: Unusual Whales, with your key held on the server.

## Setup on Cloudflare (Workers)

The project `marketcyclelab` in Workers & Pages builds from GitHub `main`.

1. In the project, open **Settings**, then **Build**. Set:
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
2. Open **Settings**, then **Variables and Secrets**. Add, each with type **Secret**:
   - `APP_PASSWORD`: the password you type to open the app, 8 characters or more
   - `UW_API_KEY`: your Unusual Whales API key
3. Open **Deployments** and retry the latest build, or wait for the next push to `main`.
4. Open the `workers.dev` address shown on the project's Overview, sign in, and bookmark it.
   On iPhone, use Share, then Add to Home Screen.

Until `APP_PASSWORD` is set the app stays closed. Changing the password signs every device out.

## What runs where

- The page and all studies run in your browser.
- `worker/index.ts` runs on Cloudflare (`wrangler.jsonc`): the password gate and the market data
  routes.
  Provider access and your key never reach the browser.
- Your watchlist, positions, notes and journal are stored in the browser you use. Use
  Portfolio, Export to move them to another device.

## For development

```bash
npm install
```

Live data on your computer (prices work without the key; earnings need it):

```bash
UW_API_KEY=your_key_here npm run dev:live
```

Synthetic data, no network:

```bash
npm run dev
```

Checks: `npm run check` (typecheck, lint, unit tests, build) and `npm run e2e` (browser checks
on synthetic data). `node e2e/live.mjs` sweeps every page against a running `dev:live` server.

## Documents

- `docs/ARCHITECTURE.md` layers, navigation choice, data flow
- `docs/PARITY_LEDGER.md` every capability, where it lives, its test and status
- `docs/EVIDENCE.md` what was verified, what was not, and what unblocks each gap
- `docs/ENGINE_CONVENTIONS.md` and `docs/UI_CONVENTIONS.md` rules for engines and views
