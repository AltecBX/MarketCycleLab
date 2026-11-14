# View conventions

Rules for every file under `src/views`. Read these shared files before writing a view and reuse
them: `src/ui/components.tsx`, `src/ui/charts.tsx`, `src/ui/format.ts`, `src/ui/tokens.css`,
`src/app/research.tsx` (`useResearch`, `RequireBars`), `src/app/routes.ts` (`researchPath`),
`src/data/client.ts` (`useAsync`, `useBars`, `useBundle`, `useGroups`, `useInstruments`,
`invalidate`), `src/data/engine.ts` (`useEngine`, `runEngine`), `src/data/workspace.ts`.

## Ownership

- A view owns its own files only. Do not edit shared files (`src/ui`, `src/app`, `src/data`,
  `src/engine`). If a shared piece is missing, build it inside your view folder and report it.
- Extra CSS goes in a stylesheet next to the view, imported by the view, with class names that
  start with a short view prefix (`wk-`, `ma-`). Use the tokens in `tokens.css`. No new colors.

## Hierarchy

- Lead with the answer: two to five key figures and one chart. Controls sit next to what they
  change. Detail (raw rows, method, diagnostics) opens through `Disclosure` or `Sheet`.
- No intro paragraphs, no repeated headings, no empty explanatory panels, no duplicate controls.
- One fact appears once per page. If the stock strip already shows it, link to it, do not repeat it.
- A card answers one question and its title says which.

## Evidence language

- Observed facts, conditional historical frequencies, validated estimates and hypothetical
  scenarios look different and are labeled.
- A frequency always shows hits, denominator and interval. Use `Freq`.
- A modeled probability renders only when its status is `valid`. Otherwise show the status,
  the reason and the descriptive counts in a `StateNote`. Never a placeholder number.
- Every figure states its endpoint, horizon, basis and dates in the label or the sub line.
- No verdict words (bullish, bearish, buy, sell as advice) and no recommended trades. Scenarios
  are labeled hypothetical.
- Text uses periods and commas. No hyphens or dashes as punctuation. Sentence case.
- Fixture mode data is synthetic. Do not write copy that implies real market facts.

## States

- Loading: `Skeleton` only for data that is pending.
- Missing: `Missing` inline or `StateNote` block with the reason from the `Unavailable`.
- Failure: scoped to the card, with a retry. `Card` already wraps its body in a boundary.
- Empty: say what would make it non empty.
- Never render `NaN`, `undefined`, or a silent zero.

## URL and navigation

- Settings that define what the user is looking at live in search params so Back and deep links
  restore them. Use `replace: true` for small tweaks, push for navigation.
- Keep `asof` and `hist` when linking inside research. `researchPath(symbol, section, { asof })`.
- A row that names a symbol links to that symbol's research.

## Responsive and accessible

- No page-level horizontal scroll at 320, 390 and 440 pixels. Wide tables use `DataTable`, which
  scrolls inside its own container, with a sticky first column. On phones prefer a compact list
  and open row detail in a `Sheet`.
- Touch targets at least 32 pixels, primary actions 44.
- Buttons are buttons. Icon-only controls have an `aria-label`. Definitions use `Info` placed
  directly beside the label they define.
- Color is never the only cue. Pair it with a sign, a glyph or text.
- Charts carry an `ariaLabel` that states the takeaway, and work with touch and keyboard.
- Check light and dark.

## Performance

- Compute with `useMemo` keyed on the bars array identity and the settings.
- Anything that can take more than about 30 ms on 7,000 bars runs in the worker through
  `useEngine(key, module, fn, () => args)`. The key must include the symbol, the as-of date and
  every setting.
- Lists longer than about 200 rows are paged.

## Verify before reporting

Each view author gets a port and a dist folder so parallel checks do not collide:

```bash
npx tsc --noEmit -p tsconfig.json          # fix every error in your files
npx eslint <your files>
BUILD=1 PORT=<port> DIST=<dist> node e2e/shot.mjs <path> <name> <viewport> <theme> fold
```

Viewports: `desktop`, `laptop`, `phoneMax` (440), `phone` (390), `narrow` (320). Themes: `light`,
`dark`. Omit `fold` for a full page capture. Look at the screenshots and fix what you see:
overflow, clipped labels, low contrast, wasted space, anything that reads as clutter.
