/** Monthly Reversal study settings. They live in the URL so Back and deep links restore the study. */
import { DEFAULTS, HORIZON_CHOICES, MAX_HORIZON, type ClassBasis, type CohortKind, type MonthlyReversalOptions } from '../../../engine/monthlyReversal';

export interface MrSettings {
  lookbackYears: number;
  horizon: number;
  bounce: number;
  downside: number;
  holdSessions: number;
  basis: ClassBasis;
  level: number;
  cohort: CohortKind;
}

export const MR_DEFAULTS: MrSettings = {
  lookbackYears: DEFAULTS.lookbackYears,
  horizon: DEFAULTS.horizon,
  bounce: DEFAULTS.bounce,
  downside: DEFAULTS.downside,
  holdSessions: DEFAULTS.holdSessions,
  basis: DEFAULTS.basis,
  level: DEFAULTS.level,
  cohort: 'similar-setup',
};

export const LOOKBACK_CHOICES = [3, 5, 10, 15, 20, 30] as const;
export const LEVEL_CHOICES = [0.9, 0.95, 0.99] as const;
export const COHORT_KINDS: readonly CohortKind[] = ['similar-setup', 'all-months', 'same-calendar-month', 'regime', 'same-earnings'];
export { HORIZON_CHOICES, MAX_HORIZON };

const num = (v: string | null, lo: number, hi: number, fallback: number): number => {
  if (v === null || v.trim() === '') return fallback;
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
};

/** Read settings from search params. Anything invalid falls back to the default. */
export const readSettings = (sp: URLSearchParams): MrSettings => {
  const cohort = sp.get('mr_c') as CohortKind | null;
  const lvl = num(sp.get('mr_lvl'), 80, 99, MR_DEFAULTS.level * 100) / 100;
  return {
    lookbackYears: Math.round(num(sp.get('mr_lb'), 1, 50, MR_DEFAULTS.lookbackYears)),
    horizon: Math.round(num(sp.get('mr_h'), 1, MAX_HORIZON, MR_DEFAULTS.horizon)),
    bounce: num(sp.get('mr_b'), 0.1, 50, MR_DEFAULTS.bounce * 100) / 100,
    downside: num(sp.get('mr_d'), 0.1, 50, MR_DEFAULTS.downside * 100) / 100,
    holdSessions: Math.round(num(sp.get('mr_hold'), 1, 20, MR_DEFAULTS.holdSessions)),
    basis: sp.get('mr_basis') === 'open' ? 'open' : 'prior-close',
    level: lvl,
    cohort: cohort && COHORT_KINDS.includes(cohort) ? cohort : MR_DEFAULTS.cohort,
  };
};

const PARAM: Record<keyof MrSettings, string> = {
  lookbackYears: 'mr_lb',
  horizon: 'mr_h',
  bounce: 'mr_b',
  downside: 'mr_d',
  holdSessions: 'mr_hold',
  basis: 'mr_basis',
  level: 'mr_lvl',
  cohort: 'mr_c',
};

const trim = (x: number): string => String(+x.toFixed(4));

const encode = <K extends keyof MrSettings>(key: K, value: MrSettings[K]): string => {
  if (key === 'bounce' || key === 'downside' || key === 'level') return trim((value as number) * 100);
  return String(value);
};

/** Write one setting. A value equal to its default is removed so default URLs stay clean. */
export const writeSetting = <K extends keyof MrSettings>(sp: URLSearchParams, key: K, value: MrSettings[K]): URLSearchParams => {
  const next = new URLSearchParams(sp);
  const same = typeof value === 'number' ? Math.abs((value as number) - (MR_DEFAULTS[key] as number)) < 1e-9 : value === MR_DEFAULTS[key];
  if (same) next.delete(PARAM[key]);
  else next.set(PARAM[key], encode(key, value));
  return next;
};

export const clearSettings = (sp: URLSearchParams): URLSearchParams => {
  const next = new URLSearchParams(sp);
  for (const p of Object.values(PARAM)) next.delete(p);
  return next;
};

const pct = (x: number): string => `${trim(x * 100)}%`;

export interface SettingChip {
  key: keyof MrSettings;
  label: string;
}

/** Chips for settings that differ from the specification defaults. The cohort is chosen on its own card. */
export const activeChips = (s: MrSettings): SettingChip[] => {
  const out: SettingChip[] = [];
  if (s.horizon !== MR_DEFAULTS.horizon) out.push({ key: 'horizon', label: `${s.horizon} sessions ahead` });
  if (s.lookbackYears !== MR_DEFAULTS.lookbackYears) out.push({ key: 'lookbackYears', label: `${s.lookbackYears} year lookback` });
  if (Math.abs(s.bounce - MR_DEFAULTS.bounce) > 1e-9) out.push({ key: 'bounce', label: `Bounce target ${pct(s.bounce)}` });
  if (Math.abs(s.downside - MR_DEFAULTS.downside) > 1e-9) out.push({ key: 'downside', label: `Downside level ${pct(s.downside)}` });
  if (s.holdSessions !== MR_DEFAULTS.holdSessions) out.push({ key: 'holdSessions', label: `Hold for ${s.holdSessions} closes` });
  if (s.basis !== MR_DEFAULTS.basis) out.push({ key: 'basis', label: 'Days classed by close vs open' });
  if (Math.abs(s.level - MR_DEFAULTS.level) > 1e-9) out.push({ key: 'level', label: `${pct(s.level)} interval` });
  return out;
};

export const settingsSummary = (s: MrSettings): string =>
  `${s.horizon} ${s.horizon === 1 ? 'session' : 'sessions'} ahead, ${s.lookbackYears} year lookback, bounce ${pct(s.bounce)}, downside ${pct(s.downside)}`;

/** Engine options for a settings object. Everything else stays at the engine defaults. */
export const toOptions = (s: MrSettings): Partial<MonthlyReversalOptions> => ({
  lookbackYears: s.lookbackYears,
  horizon: s.horizon,
  bounce: s.bounce,
  downside: s.downside,
  holdSessions: s.holdSessions,
  basis: s.basis,
  level: s.level,
});

/** Stable key of every setting that changes the study result. The cohort only selects a view of it. */
export const studyKey = (s: MrSettings): string => [s.lookbackYears, s.horizon, trim(s.bounce), trim(s.downside), s.holdSessions, s.basis, trim(s.level)].join('|');
