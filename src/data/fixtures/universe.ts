/**
 * Instrument identity and curated trading groups for the fixture universe.
 *
 * Identity facts here (names, former tickers, spin-off boundaries, themes) come from the owner's
 * rebuild specification. They were not re-verified against issuer filings in the build session,
 * and each alias or boundary says so in its evidence note. Prices for these symbols in fixture
 * mode are synthetic. See synthetic.ts.
 *
 * `listed` below is the first session of the fixture history for that symbol. It exists to exercise
 * short-history handling. It is not a verified listing date and the UI labels it "History starts".
 */
import type { Instrument, SecurityType } from '../../engine/core/types';
import type { TradingGroup } from '../contracts';

const SPEC = 'Owner specification, not re-verified against issuer filings';

interface Row {
  s: string;
  n: string;
  t?: SecurityType;
  x?: string;
  sec?: string;
  ind?: string;
  etf?: string;
  listed?: string;
  country?: string;
}

const rows: Row[] = [
  { s: 'NVDA', n: 'NVIDIA Corporation', sec: 'Technology', ind: 'Semiconductors', etf: 'XLK', listed: '1999-01-22' },
  { s: 'AMD', n: 'Advanced Micro Devices, Inc.', sec: 'Technology', ind: 'Semiconductors', etf: 'XLK' },
  { s: 'MU', n: 'Micron Technology, Inc.', sec: 'Technology', ind: 'Semiconductors', etf: 'XLK' },
  { s: 'SNDK', n: 'Sandisk Corporation', sec: 'Technology', ind: 'Computer Hardware', etf: 'XLK', listed: '2025-02-24' },
  { s: 'STX', n: 'Seagate Technology Holdings plc', sec: 'Technology', ind: 'Computer Hardware', etf: 'XLK' },
  { s: 'WDC', n: 'Western Digital Corporation', sec: 'Technology', ind: 'Computer Hardware', etf: 'XLK' },
  { s: 'INTC', n: 'Intel Corporation', sec: 'Technology', ind: 'Semiconductors', etf: 'XLK' },
  { s: 'TSM', n: 'Taiwan Semiconductor Manufacturing Company Limited', t: 'adr', x: 'NYSE', sec: 'Technology', ind: 'Semiconductors', etf: 'XLK', country: 'Taiwan' },
  { s: 'MRVL', n: 'Marvell Technology, Inc.', sec: 'Technology', ind: 'Semiconductors', etf: 'XLK' },
  { s: 'AVGO', n: 'Broadcom Inc.', sec: 'Technology', ind: 'Semiconductors', etf: 'XLK' },
  { s: 'QCOM', n: 'QUALCOMM Incorporated', sec: 'Technology', ind: 'Semiconductors', etf: 'XLK' },
  { s: 'CBRS', n: 'Cerebras Systems Inc.', sec: 'Technology', ind: 'Semiconductors', etf: 'XLK', listed: '2026-03-12' },
  { s: 'VRT', n: 'Vertiv Holdings Co', x: 'NYSE', sec: 'Industrials', ind: 'Electrical Equipment', etf: 'XLI', listed: '2020-02-10' },
  { s: 'GEV', n: 'GE Vernova Inc.', x: 'NYSE', sec: 'Industrials', ind: 'Electrical Equipment', etf: 'XLI', listed: '2024-04-02' },
  { s: 'ETN', n: 'Eaton Corporation plc', x: 'NYSE', sec: 'Industrials', ind: 'Electrical Equipment', etf: 'XLI' },
  { s: 'NVT', n: 'nVent Electric plc', x: 'NYSE', sec: 'Industrials', ind: 'Electrical Equipment', etf: 'XLI', listed: '2018-05-01' },
  { s: 'LITE', n: 'Lumentum Holdings Inc.', sec: 'Technology', ind: 'Communication Equipment', etf: 'XLK', listed: '2015-08-04' },
  { s: 'AAOI', n: 'Applied Optoelectronics, Inc.', sec: 'Technology', ind: 'Communication Equipment', etf: 'XLK', listed: '2013-09-26' },
  { s: 'COHR', n: 'Coherent Corp.', x: 'NYSE', sec: 'Technology', ind: 'Scientific Instruments', etf: 'XLK' },
  { s: 'AXTI', n: 'AXT, Inc.', sec: 'Technology', ind: 'Semiconductor Materials', etf: 'XLK' },
  { s: 'IONQ', n: 'IonQ, Inc.', x: 'NYSE', sec: 'Technology', ind: 'Computer Hardware', etf: 'XLK', listed: '2021-10-01' },
  { s: 'RGTI', n: 'Rigetti Computing, Inc.', sec: 'Technology', ind: 'Computer Hardware', etf: 'XLK', listed: '2022-03-02' },
  { s: 'QBTS', n: 'D-Wave Quantum Inc.', x: 'NYSE', sec: 'Technology', ind: 'Computer Hardware', etf: 'XLK', listed: '2022-08-08' },
  { s: 'ARQQ', n: 'Arqit Quantum Inc.', sec: 'Technology', ind: 'Software', etf: 'XLK', listed: '2021-09-07', country: 'United Kingdom' },
  { s: 'INFQ', n: 'Infleqtion, Inc.', x: 'NYSE', sec: 'Technology', ind: 'Computer Hardware', etf: 'XLK', listed: '2025-05-14' },
  { s: 'AAPL', n: 'Apple Inc.', sec: 'Technology', ind: 'Consumer Electronics', etf: 'XLK' },
  { s: 'MSFT', n: 'Microsoft Corporation', sec: 'Technology', ind: 'Software', etf: 'XLK' },
  { s: 'GOOGL', n: 'Alphabet Inc.', sec: 'Communication Services', ind: 'Internet Content', etf: 'XLC' },
  { s: 'AMZN', n: 'Amazon.com, Inc.', sec: 'Consumer Discretionary', ind: 'Internet Retail', etf: 'XLY' },
  { s: 'META', n: 'Meta Platforms, Inc.', sec: 'Communication Services', ind: 'Internet Content', etf: 'XLC', listed: '2012-05-18' },
  { s: 'TSLA', n: 'Tesla, Inc.', sec: 'Consumer Discretionary', ind: 'Auto Manufacturers', etf: 'XLY', listed: '2010-06-29' },
  { s: 'LLY', n: 'Eli Lilly and Company', x: 'NYSE', sec: 'Health Care', ind: 'Drug Manufacturers', etf: 'XLV' },
  { s: 'UNH', n: 'UnitedHealth Group Incorporated', x: 'NYSE', sec: 'Health Care', ind: 'Healthcare Plans', etf: 'XLV' },
  { s: 'CAT', n: 'Caterpillar Inc.', x: 'NYSE', sec: 'Industrials', ind: 'Farm and Heavy Machinery', etf: 'XLI' },
  { s: 'JPM', n: 'JPMorgan Chase & Co.', x: 'NYSE', sec: 'Financials', ind: 'Banks', etf: 'XLF' },
  { s: 'XOM', n: 'Exxon Mobil Corporation', x: 'NYSE', sec: 'Energy', ind: 'Oil and Gas Integrated', etf: 'XLE' },
  { s: 'COST', n: 'Costco Wholesale Corporation', sec: 'Consumer Staples', ind: 'Discount Stores', etf: 'XLP' },
  { s: 'WMT', n: 'Walmart Inc.', x: 'NYSE', sec: 'Consumer Staples', ind: 'Discount Stores', etf: 'XLP' },
  { s: 'BABA', n: 'Alibaba Group Holding Limited', t: 'adr', x: 'NYSE', sec: 'Consumer Discretionary', ind: 'Internet Retail', etf: 'XLY', listed: '2014-09-19', country: 'China' },
  { s: 'PDD', n: 'PDD Holdings Inc.', t: 'adr', sec: 'Consumer Discretionary', ind: 'Internet Retail', etf: 'XLY', listed: '2018-07-26', country: 'China' },
  { s: 'SPY', n: 'SPDR S&P 500 ETF Trust', t: 'etf', x: 'NYSE Arca' },
  { s: 'QQQ', n: 'Invesco QQQ Trust', t: 'etf' },
  { s: 'SMH', n: 'VanEck Semiconductor ETF', t: 'etf' },
  { s: 'DRAM', n: 'Roundhill Memory ETF', t: 'etf', x: 'NYSE Arca', listed: '2025-09-17' },
  { s: 'KWEB', n: 'KraneShares CSI China Internet ETF', t: 'etf', x: 'NYSE Arca', listed: '2013-08-01', country: 'China' },
  { s: 'MCHI', n: 'iShares MSCI China ETF', t: 'etf', listed: '2011-03-31', country: 'China' },
  { s: 'FXI', n: 'iShares China Large-Cap ETF', t: 'etf', x: 'NYSE Arca', country: 'China' },
  { s: 'XLB', n: 'Materials Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca' },
  { s: 'XLC', n: 'Communication Services Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca', listed: '2018-06-19' },
  { s: 'XLE', n: 'Energy Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca' },
  { s: 'XLF', n: 'Financial Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca' },
  { s: 'XLI', n: 'Industrial Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca' },
  { s: 'XLK', n: 'Technology Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca' },
  { s: 'XLP', n: 'Consumer Staples Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca' },
  { s: 'XLRE', n: 'Real Estate Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca', listed: '2015-10-08' },
  { s: 'XLU', n: 'Utilities Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca' },
  { s: 'XLV', n: 'Health Care Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca' },
  { s: 'XLY', n: 'Consumer Discretionary Select Sector SPDR Fund', t: 'etf', x: 'NYSE Arca' },
];

export const SECTOR_ETFS = ['XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY'] as const;
export const DEFAULT_BENCHMARKS = ['SPY', 'QQQ', 'SMH', 'XLK'] as const;

export const INSTRUMENTS: Instrument[] = rows.map((r) => {
  const inst: Instrument = {
    id: `us:${r.s.toLowerCase()}`,
    symbol: r.s,
    name: r.n,
    exchange: r.x ?? 'NASDAQ',
    currency: 'USD',
    type: r.t ?? 'stock',
    aliases: [],
  };
  if (r.sec) inst.sector = r.sec;
  if (r.ind) inst.industry = r.ind;
  if (r.etf) inst.sectorEtf = r.etf;
  if (r.listed) inst.listedOn = r.listed;
  if (r.country) inst.country = r.country;
  return inst;
});

const byId = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

// Former ticker of the same continuous security. Evidence quality is stated, not assumed.
byId.get('INFQ')!.aliases.push({
  symbol: 'CCCX',
  from: null,
  to: null,
  evidence: `${SPEC}. The effective dates of the symbol change are not verified, so no as-of window is asserted.`,
});
// Current SNDK begins at the February 2025 spin-off. Legacy SanDisk and WDC history is a different basis.
byId.get('SNDK')!.basisBoundary = {
  date: '2025-02-24',
  reason: `Spin-off from Western Digital. History before this date is not the current security. ${SPEC}.`,
};
byId.get('WDC')!.basisBoundary = {
  date: '2025-02-24',
  reason: `Sandisk separated on this date. Returns across the boundary are not comparable without an adjustment factor. ${SPEC}.`,
};

const G = (id: string, name: string, members: string[], basis: string, kind: TradingGroup['kind'] = 'curated-theme'): TradingGroup => ({
  id,
  name,
  kind,
  members,
  basis,
  asOf: '2026-11-13',
});

/** Curated themes. A manual theme is a research grouping. It is not evidence of co-movement. */
export const GROUPS: TradingGroup[] = [
  G('ai-chips', 'AI Chips and Processors', ['NVDA', 'AMD', 'AVGO', 'MRVL', 'CBRS'], `Curated theme. ${SPEC}. CBRS placed here on issuer business line, not on a provider software label.`),
  G('memory-storage', 'Memory and Storage', ['SNDK', 'MU', 'STX', 'WDC', 'DRAM'], `Curated theme. ${SPEC}. DRAM is an ETF and is labeled as one.`),
  G('power-cooling', 'Power, Cooling and Electrical Infrastructure', ['VRT', 'GEV', 'ETN', 'NVT'], `Curated theme. ${SPEC}.`),
  G('optical', 'Optical Networking and Photonics', ['LITE', 'AAOI', 'COHR', 'AXTI'], `Curated theme. ${SPEC}.`),
  G('quantum', 'Quantum', ['IONQ', 'RGTI', 'QBTS', 'ARQQ', 'INFQ'], `Curated theme. ${SPEC}. INFQ is the current symbol of the former CCCX listing.`),
  G('china', 'China Exposure', ['BABA', 'PDD', 'KWEB', 'MCHI', 'FXI'], `Curated theme. ${SPEC}. KWEB, MCHI and FXI are ETFs.`),
  G('foundry', 'Foundry and Manufacturing', ['TSM', 'INTC'], `Curated cross-theme link on shared foundry exposure. ${SPEC}.`),
  G('chip-design', 'Chip Design and Connectivity', ['MRVL', 'AVGO', 'QCOM'], `Curated cross-theme link. ${SPEC}.`),
  G('mega-cap', 'Mega Cap Platforms', ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA'], 'Curated theme for the fixture universe.'),
  G('health-care', 'Health Care', ['LLY', 'UNH'], 'Curated theme for the fixture universe.'),
  G('cyclicals', 'Cyclicals and Staples', ['CAT', 'JPM', 'XOM', 'COST', 'WMT'], 'Curated theme for the fixture universe.'),
];

/** The one deterministic display group per symbol, used where a table needs a single label. */
export const primaryGroupOf = (symbol: string): TradingGroup | null => GROUPS.find((g) => g.members.includes(symbol)) ?? null;
