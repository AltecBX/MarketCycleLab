# S&P 500 market study (monthly data through 2026-09-01)

Source: Shiller monthly S&P 500 (monthly average prices), datahub mirror. Monthly averages make declines shallower than daily closes (2007 to 2009 shows about -51% here vs -57% on daily closes). n_eff = non-overlapping events; grades use n_eff. Intervals are Wilson 95%.

## 1. Extended downturns of 10%+ since 1950 (high to full recovery)

| Peak | Trough | Depth | Months down | Months to recover | Total months |
|---|---|---|---|---|---|
| 1953-01 | 1953-09 | -11.1% | 8 | 6 | 14 |
| 1956-07 | 1957-12 | -17.3% | 17 | 9 | 26 |
| 1959-07 | 1960-10 | -10.1% | 15 | 4 | 19 |
| 1961-12 | 1962-06 | -22.5% | 6 | 15 | 21 |
| 1966-01 | 1966-10 | -17.3% | 9 | 10 | 19 |
| 1968-12 | 1970-06 | -29.0% | 18 | 21 | 39 |
| 1973-01 | 1974-12 | -43.4% | 23 | 67 | 90 |
| 1980-11 | 1982-07 | -19.4% | 20 | 4 | 24 |
| 1987-08 | 1987-12 | -26.8% | 4 | 19 | 23 |
| 1990-06 | 1990-10 | -14.8% | 4 | 4 | 8 |
| 1998-07 | 1998-09 | -11.8% | 2 | 3 | 5 |
| 2000-08 | 2003-02 | -43.7% | 30 | 51 | 81 |
| 2007-10 | 2009-03 | -50.8% | 17 | 48 | 65 |
| 2018-09 | 2018-12 | -11.5% | 3 | 4 | 7 |
| 2020-01 | 2020-03 | -19.1% | 2 | 5 | 7 |
| 2021-12 | 2022-10 | -20.3% | 10 | 14 | 24 |
| 2025-02 | 2025-04 | -11.1% | 2 | 3 | 5 |

Swing declines of 10%+: 22 since 1950. 19 started near an all-time high; 3 were repeat legs inside an existing downturn.

## 2. Calendar months (walk-forward)

Predicting each month from earlier years only: 269 calls, accuracy 64% (95% 58% to 70%) vs 64% for always calling 'up'. Edge +0%. Down calls made: 0.

| period | n | hit_rate | ci_low | ci_high | median | worst | failed |
|---|---|---|---|---|---|---|---|
| Jan | 76 | 67% | 56% | 77% | +1.4% | -6.8% | 25 |
| Feb | 77 | 55% | 43% | 65% | +1.0% | -7.0% | 35 |
| Mar | 77 | 58% | 47% | 69% | +0.7% | -19.1% | 32 |
| Apr | 77 | 73% | 62% | 81% | +1.3% | -5.5% | 21 |
| May | 77 | 61% | 50% | 71% | +0.8% | -11.5% | 30 |
| Jun | 77 | 61% | 50% | 71% | +0.6% | -11.7% | 30 |
| Jul | 77 | 65% | 54% | 75% | +0.9% | -11.7% | 27 |
| Aug | 77 | 61% | 50% | 71% | +0.4% | -10.6% | 30 |
| Sep | 77 | 57% | 46% | 68% | +1.0% | -11.4% | 33 |
| Oct | 76 | 54% | 43% | 65% | +0.3% | -20.4% | 35 |
| Nov | 76 | 67% | 56% | 77% | +1.8% | -12.6% | 25 |
| Dec | 76 | 74% | 63% | 82% | +1.5% | -7.1% | 20 |

## 3. Trend: above or below the 10-month average

Hit = a further decline of 10% or more within 12 months. In this table the ret columns are the worst decline within the next 12 months.

| bucket | n | n_eff | hit_rate | ci_low | ci_high | base_rate | lift | grade | ret_median | ret_p10 | ret_p90 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| above_10m_avg | 655 | 67 | 15% | 8% | 25% | 21% | 0.72 | C | -1.4% | -12.7% | +0.0% |
| below_10m_avg | 254 | 42 | 36% | 23% | 51% | 21% | 1.71 | B | -5.1% | -24.8% | +0.0% |
| ALL | 909 | 76 | 21% | 13% | 31% | 21% | 1.00 | C | -2.0% | -16.5% | +0.0% |

Held before and after 1990:

| period | bucket | n | n_eff | hit_rate | base_rate | lift |
|---|---|---|---|---|---|---|
| before 1990 | above_10m_avg | 331 | 36 | 17% | 23% | 0.75 |
| before 1990 | below_10m_avg | 149 | 23 | 36% | 23% | 1.55 |
| after 1990 | above_10m_avg | 324 | 32 | 13% | 19% | 0.69 |
| after 1990 | below_10m_avg | 105 | 19 | 37% | 19% | 1.94 |

12-month return by trend (hit = positive):

| bucket | n | n_eff | hit_rate | ci_low | ci_high | base_rate | lift | grade | ret_median | ret_p10 | ret_p90 | mae_median |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| above_10m_avg | 655 | 67 | 76% | 65% | 85% | 75% | 1.02 | C | +9.9% | -8.0% | +26.8% | -1.4% |
| below_10m_avg | 254 | 42 | 70% | 54% | 81% | 75% | 0.94 | C | +12.4% | -19.8% | +32.2% | -5.1% |
| ALL | 909 | 76 | 75% | 64% | 83% | 75% | 1.00 | C | +10.5% | -11.8% | +28.1% | -2.0% |

## 4. Valuation: CAPE percentile vs its own history (point-in-time, from 1881)

Latest CAPE in this dataset: 30.8 (2023-09-01), percentile 95%. The mirror stopped updating earnings and CAPE in 2023, so today's level is not in this data.

Next 12 months (hit = positive):

| bucket | n | n_eff | hit_rate | ci_low | ci_high | base_rate | lift | grade | ret_median | ret_p10 | ret_p90 | mae_median |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-20 | 118 | 11 | 81% | 52% | 95% | 74% | 1.10 | C | +12.4% | -7.5% | +29.8% | -1.6% |
| 20-40 | 84 | 12 | 73% | 47% | 91% | 74% | 0.98 | C | +13.6% | -6.7% | +33.2% | -1.7% |
| 40-60 | 84 | 11 | 83% | 52% | 95% | 74% | 1.13 | C | +16.1% | -9.2% | +34.4% | +0.0% |
| 60-80 | 129 | 19 | 71% | 46% | 85% | 74% | 0.95 | C | +9.0% | -11.8% | +23.6% | -3.9% |
| 80-100 | 473 | 45 | 72% | 57% | 82% | 74% | 0.97 | C | +8.8% | -14.4% | +25.5% | -2.4% |
| ALL | 888 | 74 | 74% | 63% | 83% | 74% | 1.00 | C | +10.2% | -11.9% | +28.2% | -2.1% |

Next 10 years, real total return (hit = above 5% a year), since 1891:

| bucket | n | n_eff | hit_rate | ci_low | ci_high | base_rate | lift | grade | ret_median | ret_p10 | ret_p90 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-20 | 399 | 8 | 71% | 41% | 93% | 64% | 1.11 | Insufficient | +9.0% | -0.5% | +16.3% |
| 20-40 | 219 | 8 | 83% | 53% | 98% | 64% | 1.31 | Insufficient | +10.1% | +3.5% | +14.8% |
| 40-60 | 159 | 8 | 75% | 41% | 93% | 64% | 1.18 | Insufficient | +9.5% | +1.6% | +14.6% |
| 60-80 | 197 | 8 | 61% | 31% | 86% | 64% | 0.97 | Insufficient | +6.8% | -1.2% | +13.5% |
| 80-100 | 497 | 8 | 46% | 22% | 78% | 64% | 0.73 | Insufficient | +4.8% | -2.4% | +8.9% |
| ALL | 1471 | 13 | 64% | 36% | 82% | 64% | 1.00 | C | +6.6% | -1.0% | +14.1% |

Walk-forward (tercile cutoffs learned before 1990, applied after):

| period | bucket | n | hit_rate | base_rate | lift | ret_median |
|---|---|---|---|---|---|---|
| in_sample | cape_pctile:low | 160 | 100% | 67% | 1.50 | +10.6% |
| in_sample | cape_pctile:mid | 160 | 71% | 67% | 1.06 | +10.3% |
| in_sample | cape_pctile:high | 160 | 30% | 67% | 0.45 | +1.1% |
| out_of_sample | cape_pctile:low | 0 |  |  |  |  |
| out_of_sample | cape_pctile:mid | 23 | 100% | 70% | 1.43 | +13.1% |
| out_of_sample | cape_pctile:high | 262 | 68% | 70% | 0.96 | +5.8% |

## 5. Volatility regime: month-end VIX vs next 12 months (1990+)

| bucket | n | n_eff | hit_rate | ci_low | ci_high | base_rate | lift | grade | ret_median | ret_p10 | ret_p90 | mae_median |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 15-20 | 132 | 27 | 85% | 68% | 94% | 81% | 1.05 | C | +11.5% | -6.6% | +26.0% | -1.4% |
| 20-30 | 129 | 22 | 67% | 47% | 84% | 81% | 0.83 | C | +10.5% | -21.7% | +27.9% | -3.6% |
| <15 | 135 | 19 | 89% | 69% | 97% | 81% | 1.10 | C | +12.2% | -0.3% | +23.9% | -0.3% |
| >30 | 33 | 9 | 85% | 56% | 98% | 81% | 1.05 | Insufficient | +20.6% | -7.7% | +40.2% | -3.5% |
| ALL | 429 | 36 | 81% | 65% | 90% | 81% | 1.00 | C | +11.8% | -12.2% | +27.2% | -1.3% |

## 6. Rates: 6-month change in the 10-year yield vs next 12 months

| bucket | n | n_eff | hit_rate | ci_low | ci_high | base_rate | lift | grade | ret_median | ret_p10 | ret_p90 | mae_median |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| falling_50bp+ | 183 | 37 | 83% | 69% | 92% | 74% | 1.11 | C | +14.8% | -7.2% | +33.2% | -0.3% |
| rising_50bp+ | 185 | 37 | 72% | 57% | 85% | 74% | 0.97 | C | +9.5% | -13.4% | +25.2% | -4.0% |
| stable | 496 | 63 | 72% | 59% | 81% | 74% | 0.97 | C | +9.8% | -11.9% | +26.4% | -2.2% |
| ALL | 864 | 72 | 74% | 62% | 82% | 74% | 1.00 | C | +10.5% | -12.3% | +28.3% | -2.1% |

## 7. Rallies and selloffs (10% zigzag, monthly, since 1950)

Completed rallies: 22, median size 55.9%, median length 26 months. Completed declines: 22, median 17.1%, median length 8 months.

Once a rally reached X, share that went further:

| current | n_reached | median_final_if_reached | p_extra_5 | p_extra_10 | p_extra_20 |
|---|---|---|---|---|---|
| +10.0% | 22 | +55.9% | +90.9% | +90.9% | +81.8% |
| +20.0% | 20 | +57.0% | +100.0% | +90.0% | +75.0% |
| +30.0% | 18 | +59.7% | +88.9% | +83.3% | +66.7% |
| +50.0% | 12 | +76.5% | +100.0% | +75.0% | +58.3% |

Once a decline reached X, share that went further:

| current | n_reached | median_final_if_reached | p_extra_5 | p_extra_10 | p_extra_20 |
|---|---|---|---|---|---|
| +10.0% | 22 | +17.1% | +59.1% | +36.4% | +9.1% |
| +15.0% | 13 | +22.5% | +61.5% | +46.2% | +15.4% |
| +20.0% | 8 | +28.2% | +75.0% | +25.0% | +25.0% |
| +30.0% | 2 | +47.1% | +100.0% | +100.0% | +50.0% |

## 8. Bounces of 10%+ off a low at least 20% below the 12-month high

Sustained = recovered half the drawdown before a new low.

| low | drawdown_at_low | outcome | months_to_outcome | extra_downside_if_failed |
|---|---|---|---|---|
| 1962-06 | -22.5% | sustained | 1 |  |
| 1970-06 | -21.4% | sustained | 2 |  |
| 1974-12 | -31.2% | sustained | 1 |  |
| 1987-12 | -26.8% | sustained | 10 |  |
| 2001-09 | -24.9% | failed | 3 | -27.5% |
| 2003-02 | -27.5% | sustained | 4 |  |
| 2009-03 | -46.0% | sustained | 7 |  |
| 2022-10 | -20.3% | sustained | 2 |  |
