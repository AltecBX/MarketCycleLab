# Engine conventions

Rules for every module under `src/engine`. The engines are the scientific core of the product, so
they are pure, deterministic and independently testable.

## Shape

- Pure TypeScript, strict mode. No DOM, no network, no `Date.now()`, no hidden state.
- The as-of date is always explicit: an argument, or the last bar of the series passed in.
- Reuse the shared primitives in `src/engine/core`. Do not duplicate them.
  - `types.ts` canonical types, `Unavailable`, `na()`, `isNa()`
  - `calendar.ts` exchange sessions, holidays, early closes, week and month helpers
  - `stats.ts` Wilson, quantiles, midrank percentile, Kaplan Meier, Brier, normal CDF and inverse
  - `indicators.ts` SMA, EMA, Wilder ATR and RSI, rolling extremes, relative volume, MACD
  - `series.ts` validation, coverage, alignment, as-of slicing, period bases, return helpers
  - `outcomes.ts` forward outcomes, first touch, horizon summaries, non-overlap selection
- Result types are designed for a view: they carry dates, denominators, exclusion counts and
  the reason for anything missing.

## Numbers

- Percent quantities are fractions. 0.05 is 5%. Percentage-point differences are fractions too
  and the view labels them "pp".
- A missing value is `Unavailable` from `na(code, detail)`. Never 0, never NaN, never an empty string.
- Every frequency carries `hits`, `n` and a Wilson interval from `wilson()`.
- Skewed outcomes report median and empirical percentiles, not only a mean.

## Time

- No look-ahead. A value at anchor i uses rows 0..i only. Forward targets, later confirmations,
  eventual bottoms and revised data never enter an earlier feature.
- Pivots, confirmations and delayed patterns carry both an event date and a confirm date. A
  pattern becomes usable on its confirm date.
- An outcome counts only when its horizon has matured. Unmatured anchors are excluded from the
  denominator and counted separately.
- An unfinished run, episode or period is active and right-censored. It is never a completed sample.
- Incomplete periods (current week, current month, listing partials) are marked and excluded from
  completed-period statistics.

## Gates

- A modeled probability is returned only when its gate passes. When it fails, return the
  descriptive counts plus a status (`not-reliable`, `insufficient-evidence`, `stale`) and no number.
- Thresholds given in the owner specification are used exactly and tagged `provenance: 'spec'`.
- Thresholds the specification delegates to the reference source, which was not available when
  this code was written, are exposed in a documented `DEFAULTS` object tagged
  `provenance: 'proposed'`. They must be reconciled with the reference before a parity claim.
- Reference checkpoint figures are never invented. A checkpoint that needs real market data is
  listed in `docs/EVIDENCE.md` as not reproduced.

## Tests

- Vitest, next to the module (`name.test.ts`).
- Hand-computed synthetic cases for each definition and for each edge case the specification lists.
- Two invariants in every engine: appending future rows does not change earlier as-of results,
  and scaling every price by one factor does not change returns or states.
- A smoke test on the synthetic fixture (`syntheticDaily`) for a long history (NVDA) and a short
  one (SNDK).

## Text

- User-facing strings use periods and commas. No hyphens or dashes as punctuation.
- Labels name the endpoint, the horizon and the basis. "Close above anchor after 20 sessions",
  not "bullish".
