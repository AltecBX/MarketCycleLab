# Market Cycle Research

Evidence-led research on stock selloffs, trends and positions. A rebuild of the owner's private
Study Market Drawdown Patterns app, written from the owner specification.

## Use it

The app is a private web page. Open your bookmark, enter your password, and it works on desktop
and iPhone. Every push to `main` redeploys it automatically.

Data sources:
- Daily prices and fundamentals: Yahoo Finance, free, completed sessions only.
- Earnings dates and results: Unusual Whales, with your key held on the server.

## One-time setup (about 5 minutes, all in the browser)

1. Go to dash.cloudflare.com and create a free account, or sign in.
2. Open **Workers & Pages**, choose **Create**, then the **Pages** tab, then
   **Connect to Git**. Allow access to the `MarketCycleLab` repository.
3. Settings:
   - Production branch: `main`
   - Framework preset: `None`
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Under **Environment variables**, add:
   - `APP_PASSWORD`: the password you will type to open the app, 8 characters or more
   - `UW_API_KEY`: your Unusual Whales API key
   Mark both as **Encrypt** (secret).
5. Choose **Save and Deploy**. When it finishes, open the `pages.dev` address it shows and
   bookmark it. On iPhone, use Share, then Add to Home Screen.

Until `APP_PASSWORD` is set the app stays closed. Changing the password signs every device out.

## What runs where

- The page and all studies run in your browser.
- `functions/_middleware.ts` runs on Cloudflare: the password gate and the market data routes.
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
