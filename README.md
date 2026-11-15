# Market Cycle Research

Evidence-led research on stock selloffs, trends and positions. A rebuild of the owner's private
Study Market Drawdown Patterns app, written from the owner specification.

This repository is public. It holds no private records, no provider data and no credentials.
The app runs in fixture mode: every price and fundamental is synthetic and labeled as synthetic.

## Run

```bash
npm install
```

```bash
npm run dev
```

## Run on live data

Prices come from the Yahoo Finance chart endpoint (no key). Earnings come from Unusual Whales and
need your key in the environment of the terminal that starts the app. The key stays on the
server side. It is never sent to the browser and never written to the repository.

```bash
UW_API_KEY=your_key_here npm run dev:live
```

Without the key, prices still load and earnings show as unavailable.

## Check

```bash
npm run check
```

```bash
npm run e2e
```

`check` runs typecheck, lint, unit tests and the production build. `e2e` runs the browser checks
against the build, so run it after `check` or `npm run build`.

## Server

The owner-only API lives in `server/`. It reads every secret from the environment and refuses to
start without them: `MCL_SESSION_SECRET`, `MCL_OWNER_PASSPHRASE_RECORD`, `MCL_JOB_TOKEN`,
`MCL_ALLOWED_ORIGIN`. Create the passphrase record by piping the passphrase into
`node --experimental-strip-types server/hash.ts`. The client is not wired to it yet.

## Documents

- `docs/ARCHITECTURE.md` layers, navigation choice, data flow
- `docs/PARITY_LEDGER.md` every capability, where it lives, its test and status
- `docs/EVIDENCE.md` what was verified, what was not, and what unblocks each gap
- `docs/ENGINE_CONVENTIONS.md` and `docs/UI_CONVENTIONS.md` rules for engines and views
