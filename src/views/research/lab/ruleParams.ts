/** Rule settings for the Lab rules tab: presets, URL encoding and plain descriptions. */
import { BOUNCE_BELOW_SMA200, STRATEGY_DEFAULTS, type Condition, type Rule } from '../../../engine/strategy';
import { fmtDate, fmtPct, fmtPp } from '../../../ui/format';

export interface RuleSettings {
  conditions: Condition[];
  trigger: Rule['trigger'];
  entry: Rule['entry'];
  horizon: number;
  costBps: number;
  /** Lookback of the "close below prior low" failure definition. 0 means none. */
  failLookback: number;
  benchmark: string;
}

export interface Preset {
  id: string;
  label: string;
  settings: RuleSettings;
}

const base = { trigger: 'first-session' as const, entry: 'signal-close' as const, costBps: STRATEGY_DEFAULTS.costBps, failLookback: 0, benchmark: 'SPY' };

export const PRESETS: Preset[] = [
  {
    id: BOUNCE_BELOW_SMA200.id,
    label: 'Bounce of 5% in five sessions below the 200 session average',
    settings: { ...base, conditions: BOUNCE_BELOW_SMA200.conditions, horizon: BOUNCE_BELOW_SMA200.horizon, failLookback: BOUNCE_BELOW_SMA200.failure?.lookback ?? 0 },
  },
  { id: 'dd20', label: 'First close 20% below the closing peak', settings: { ...base, conditions: [{ kind: 'drawdown', atLeast: 0.2 }], horizon: 20 } },
  { id: 'reclaim200', label: 'First close back above the 200 session average', settings: { ...base, conditions: [{ kind: 'sma', n: 200, side: 'above' }], horizon: 20 } },
  { id: 'down10in5', label: 'Down 10% or more over five sessions', settings: { ...base, conditions: [{ kind: 'move', sessions: 5, atMost: -0.1 }], horizon: 10 } },
  { id: 'lag10', label: 'Lagging the benchmark by 10 pp over 20 sessions', settings: { ...base, conditions: [{ kind: 'relative', sessions: 20, atMost: -0.1 }], horizon: 20 } },
];

export const DEFAULT_SETTINGS: RuleSettings = PRESETS[0]!.settings;

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s === '') return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};

export const encodeConditions = (cs: readonly Condition[]): string =>
  cs
    .map((c) => {
      switch (c.kind) {
        case 'drawdown':
          return ['dd', c.atLeast, c.lookback ?? ''].join('~');
        case 'sma':
          return ['sma', c.n, c.side].join('~');
        case 'move':
          return ['mv', c.sessions, c.atLeast ?? '', c.atMost ?? ''].join('~');
        case 'relative':
          return ['rel', c.sessions, c.atLeast ?? '', c.atMost ?? ''].join('~');
      }
    })
    .join(',');

export const decodeConditions = (text: string): Condition[] | null => {
  const out: Condition[] = [];
  for (const part of text.split(',')) {
    const [k, a, b, c] = part.split('~');
    const x = num(a);
    if (k === 'dd' && x !== undefined && x > 0) out.push(num(b) ? { kind: 'drawdown', atLeast: x, lookback: Math.round(num(b)!) } : { kind: 'drawdown', atLeast: x });
    else if (k === 'sma' && x !== undefined && x >= 2 && (b === 'above' || b === 'below')) out.push({ kind: 'sma', n: Math.round(x), side: b });
    else if ((k === 'mv' || k === 'rel') && x !== undefined && x >= 1 && (num(b) !== undefined || num(c) !== undefined)) {
      const cond: { sessions: number; atLeast?: number; atMost?: number } = { sessions: Math.round(x) };
      if (num(b) !== undefined) cond.atLeast = num(b)!;
      if (num(c) !== undefined) cond.atMost = num(c)!;
      out.push(k === 'mv' ? { kind: 'move', ...cond } : { kind: 'relative', ...cond });
    } else return null;
  }
  return out.length ? out.slice(0, 4) : null;
};

/** Read settings from the URL. Anything missing or invalid falls back to the default preset. */
export const settingsFromParams = (sp: URLSearchParams): RuleSettings => {
  const d = DEFAULT_SETTINGS;
  const conds = sp.get('cond') ? decodeConditions(sp.get('cond')!) : null;
  const h = num(sp.get('h') ?? undefined);
  const cost = num(sp.get('cost') ?? undefined);
  const fail = num(sp.get('fail') ?? undefined);
  const usingDefault = conds === null;
  return {
    conditions: conds ?? d.conditions,
    trigger: sp.get('trig') === 'every' ? 'every-session' : 'first-session',
    entry: sp.get('entry') === 'open' ? 'next-open' : 'signal-close',
    horizon: h !== undefined && h >= 1 && h <= 250 ? Math.round(h) : usingDefault ? d.horizon : 20,
    costBps: cost !== undefined && cost >= 0 && cost <= 200 ? cost : d.costBps,
    failLookback: fail !== undefined && fail >= 0 && fail <= 60 ? Math.round(fail) : usingDefault ? d.failLookback : 0,
    benchmark: (sp.get('bm') ?? d.benchmark).toUpperCase(),
  };
};

export const settingsToPatch = (s: RuleSettings): Record<string, string | null> => ({
  cond: encodeConditions(s.conditions),
  trig: s.trigger === 'every-session' ? 'every' : null,
  entry: s.entry === 'next-open' ? 'open' : null,
  h: String(s.horizon),
  cost: s.costBps === STRATEGY_DEFAULTS.costBps ? null : String(s.costBps),
  fail: s.failLookback ? String(s.failLookback) : '0',
  bm: s.benchmark === 'SPY' ? null : s.benchmark,
  page: null,
});

export const settingsKey = (s: RuleSettings): string =>
  [encodeConditions(s.conditions), s.trigger, s.entry, s.horizon, s.costBps, s.failLookback, s.conditions.some((c) => c.kind === 'relative') ? s.benchmark : ''].join('|');

export const presetOf = (s: RuleSettings): Preset | null => PRESETS.find((p) => settingsKey(p.settings) === settingsKey({ ...s, costBps: p.settings.costBps })) ?? null;

export const toRule = (s: RuleSettings): Rule => {
  const rule: Rule = {
    id: presetOf(s)?.id ?? 'custom',
    label: describeConditions(s, null).join('. '),
    conditions: s.conditions,
    trigger: s.trigger,
    entry: s.entry,
    horizon: s.horizon,
  };
  if (s.failLookback > 0) rule.failure = { kind: 'close-below-prior-low', lookback: s.failLookback };
  return rule;
};

/** Warm-up sessions each condition needs before it can be evaluated. */
export const warmupOf = (cs: readonly Condition[]): number =>
  Math.max(0, ...cs.map((c) => (c.kind === 'sma' ? c.n - 1 : c.kind === 'drawdown' ? (c.lookback ? c.lookback - 1 : 0) : c.sessions)));

const bound = (lo: number | undefined, hi: number | undefined, f: (x: number) => string): string =>
  lo !== undefined && hi !== undefined ? `between ${f(lo)} and ${f(hi)}` : lo !== undefined ? `of ${f(lo)} or more` : `of ${f(hi!)} or less`;

/** One plain sentence fragment per condition. `peakFrom` dates the running peak when history is cut. */
export const describeConditions = (s: RuleSettings, peakFrom: string | null): string[] =>
  s.conditions.map((c) => {
    switch (c.kind) {
      case 'drawdown':
        return `Close at least ${fmtPct(c.atLeast, 1, false)} below ${c.lookback ? `the highest close of the last ${c.lookback} sessions` : `the running closing peak${peakFrom ? ` since ${fmtDate(peakFrom)}` : ''}`}`;
      case 'sma':
        return `Close ${c.side} the ${c.n} session average`;
      case 'move':
        return `Close to close move over ${c.sessions} sessions ${bound(c.atLeast, c.atMost, (x) => fmtPct(x, 1))}`;
      case 'relative':
        return `Move over ${c.sessions} sessions minus ${s.benchmark} ${bound(c.atLeast, c.atMost, (x) => fmtPp(x, 1))}`;
    }
  });
