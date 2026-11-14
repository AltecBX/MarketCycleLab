/** Route table, research sections and aliases for older deep links. */

export const SECTIONS = [
  { id: 'overview', label: 'Overview', question: 'What changed and how unusual is it' },
  { id: 'selloffs', label: 'Selloffs', question: 'How does this decline compare with earlier ones' },
  { id: 'trend', label: 'Trend', question: 'How long do runs above and below the averages last' },
  { id: 'calendar', label: 'Calendar', question: 'Monthly, weekly and yearly returns' },
  { id: 'strength', label: 'Strength', question: 'Is it leading or lagging, and do breakouts hold' },
  { id: 'earnings', label: 'Earnings', question: 'Next report and past reactions' },
  { id: 'business', label: 'Business', question: 'Valuation, cash and checkpoints' },
  { id: 'forecasts', label: 'Forecasts', question: 'Gated model estimates' },
  { id: 'lab', label: 'Lab', question: 'Rule tests and sentiment' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];
export const isSection = (s: string | undefined): s is SectionId => SECTIONS.some((x) => x.id === s);

export const DEFAULT_SYMBOL = 'NVDA';
const LAST_KEY = 'mcl.symbol';

export const lastSymbol = (): string => {
  try {
    return globalThis.localStorage?.getItem(LAST_KEY) || DEFAULT_SYMBOL;
  } catch {
    return DEFAULT_SYMBOL;
  }
};
export const rememberSymbol = (s: string): void => {
  try {
    globalThis.localStorage?.setItem(LAST_KEY, s);
  } catch {
    /* ignore */
  }
};

/** Link to a research section for a symbol, keeping an as-of cut when one is active. */
export const researchPath = (symbol: string, section: SectionId = 'overview', params?: Record<string, string | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v) q.set(k, v);
  const qs = q.toString();
  return `/research/${encodeURIComponent(symbol.toUpperCase())}/${section}${qs ? `?${qs}` : ''}`;
};

/**
 * Older destinations mapped to their new home. The exact legacy route names could not be read
 * from the reference source, so these cover the names in the owner's specification.
 * `:symbol` is replaced with the last viewed symbol.
 */
export const LEGACY_ALIASES: Record<string, string> = {
  '/today': '/',
  '/decision-brief': '/',
  '/command-center': '/',
  '/earnings': '/discover/earnings',
  '/my-portfolio': '/portfolio',
  '/protection': '/portfolio/protection',
  '/big-declines': '/research/:symbol/selloffs',
  '/stock-screener': '/discover',
  '/screener': '/discover',
  '/watchlist': '/',
  '/data-and-methods': '/data',
  '/research/price': '/research/:symbol/overview',
  '/research/drawdowns': '/research/:symbol/selloffs',
  '/research/monthly-reversal': '/research/:symbol/selloffs',
  '/research/relative-strength': '/research/:symbol/strength',
  '/research/business-checkpoints': '/research/:symbol/business',
  '/research/moving-averages': '/research/:symbol/trend',
  '/research/valuation': '/research/:symbol/business',
  '/research/strategy-tests': '/research/:symbol/lab',
  '/research/research-lab': '/research/:symbol/lab',
  '/research/fear-and-greed': '/research/:symbol/lab',
  '/research/data-and-methods': '/data',
};
