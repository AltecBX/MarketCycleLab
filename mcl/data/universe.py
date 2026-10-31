"""Market, sector and industry proxies, and how a stock maps onto them.

Sector proxies are the Select Sector SPDR ETFs (GICS sectors). Industry
proxies are liquid ETFs chosen by GICS sub-industry keywords; edit
INDUSTRY_ETFS or data/user/peers.json to change any mapping.
"""
from __future__ import annotations

import json

from ..config import USER_DIR

MARKET = {"SPY": "S&P 500", "QQQ": "Nasdaq 100", "IWM": "Russell 2000", "DIA": "Dow 30", "RSP": "S&P 500 Equal Weight"}

SECTOR_ETFS = {
    "Information Technology": "XLK", "Financials": "XLF", "Health Care": "XLV", "Energy": "XLE",
    "Industrials": "XLI", "Consumer Discretionary": "XLY", "Consumer Staples": "XLP", "Utilities": "XLU",
    "Materials": "XLB", "Real Estate": "XLRE", "Communication Services": "XLC",
}
# Yahoo uses its own sector names
YAHOO_SECTOR_TO_GICS = {
    "Technology": "Information Technology", "Financial Services": "Financials", "Healthcare": "Health Care",
    "Energy": "Energy", "Industrials": "Industrials", "Consumer Cyclical": "Consumer Discretionary",
    "Consumer Defensive": "Consumer Staples", "Utilities": "Utilities", "Basic Materials": "Materials",
    "Real Estate": "Real Estate", "Communication Services": "Communication Services",
}

# (keyword in GICS sub-industry or Yahoo industry, lowercase) -> industry ETF
INDUSTRY_ETFS = [
    ("semiconductor", "SMH"), ("application software", "IGV"), ("systems software", "IGV"),
    ("software", "IGV"), ("regional bank", "KRE"), ("diversified bank", "KBE"), ("banks", "KBE"),
    ("biotech", "XBI"), ("pharmaceutical", "XPH"), ("drug manufacturers", "XPH"),
    ("health care equipment", "IHI"), ("medical devices", "IHI"), ("medical instruments", "IHI"),
    ("homebuild", "ITB"), ("residential construction", "ITB"), ("building products", "XHB"),
    ("aerospace", "ITA"), ("defense", "ITA"), ("passenger airline", "JETS"), ("airlines", "JETS"),
    ("oil & gas exploration", "XOP"), ("oil & gas e&p", "XOP"), ("oil & gas equipment", "OIH"),
    ("oil & gas refining", "CRAK"), ("integrated oil", "XLE"), ("gold", "GDX"), ("silver", "SIL"),
    ("copper", "COPX"), ("steel", "SLX"), ("metals & mining", "XME"), ("other industrial metals", "XME"),
    ("insurance", "KIE"), ("investment banking", "IAI"), ("capital markets", "KCE"),
    ("asset management", "KCE"), ("financial exchanges", "KCE"), ("transaction & payment", "IPAY"),
    ("credit services", "IPAY"), ("internet", "FDN"), ("interactive media", "FDN"),
    ("broadline retail", "XRT"), ("internet retail", "XRT"), ("specialty retail", "XRT"),
    ("apparel retail", "XRT"), ("department stores", "XRT"), ("restaurants", "EATZ"),
    ("hotels", "PEJ"), ("casinos", "BJK"), ("cruise", "PEJ"), ("leisure", "PEJ"),
    ("automobile manufacturers", "CARZ"), ("auto manufacturers", "CARZ"), ("auto parts", "CARZ"),
    ("trucking", "IYT"), ("railroads", "IYT"), ("air freight", "IYT"), ("marine", "IYT"),
    ("integrated freight", "IYT"), ("telecom", "IYZ"), ("cable", "IYZ"), ("solar", "TAN"),
    ("renewable", "ICLN"), ("electric utilities", "XLU"), ("utilities", "XLU"),
    ("reit", "VNQ"), ("real estate", "VNQ"), ("data center", "SRVR"), ("cyber", "CIBR"),
    ("electronic components", "SOXX"),
    ("technology hardware", "XLK"), ("consumer electronics", "XLK"), ("it services", "IGV"),
    ("information technology services", "IGV"), ("chemicals", "XLB"), ("specialty chemicals", "XLB"),
    ("packaged foods", "PBJ"), ("beverages", "PBJ"), ("household products", "XLP"),
    ("tobacco", "XLP"), ("uranium", "URA"), ("lithium", "LIT"),
]


def industry_etf(sub_industry: str | None) -> str | None:
    s = (sub_industry or "").lower()
    for key, etf in INDUSTRY_ETFS:
        if key in s:
            return etf
    return None


def sector_etf(sector: str | None) -> str | None:
    if not sector:
        return None
    return SECTOR_ETFS.get(sector) or SECTOR_ETFS.get(YAHOO_SECTOR_TO_GICS.get(sector, ""))


def user_overrides() -> dict:
    p = USER_DIR / "peers.json"
    if p.exists():
        return json.loads(p.read_text())
    return {}


def classify(ticker: str, constituents=None, profile: dict | None = None) -> dict:
    """Sector, industry, proxies and peers for a ticker.

    Order: data/user/peers.json override, S&P 500 GICS table, Yahoo profile.
    Peers default to S&P 500 members in the same GICS sub-industry.
    """
    tk = ticker.upper()
    out = {"ticker": tk, "sector": None, "industry": None, "sector_etf": None, "industry_etf": None,
           "peers": [], "source": None}
    if tk in MARKET or tk in SECTOR_ETFS.values():
        out.update({"source": "proxy", "sector_etf": tk if tk in SECTOR_ETFS.values() else None})
        return out
    if constituents is not None and len(constituents):
        row = constituents[constituents["Symbol"].str.upper() == tk]
        if len(row):
            r = row.iloc[0]
            out.update({"sector": r["GICS Sector"], "industry": r["GICS Sub-Industry"], "source": "GICS (S&P 500)"})
            same = constituents[(constituents["GICS Sub-Industry"] == r["GICS Sub-Industry"])
                                & (constituents["Symbol"].str.upper() != tk)]
            out["peers"] = same["Symbol"].str.upper().tolist()
    if out["sector"] is None and profile:
        out.update({"sector": YAHOO_SECTOR_TO_GICS.get(profile.get("sector"), profile.get("sector")),
                    "industry": profile.get("industry"), "source": "Yahoo"})
    out["sector_etf"] = sector_etf(out["sector"])
    out["industry_etf"] = industry_etf(out["industry"])
    ov = user_overrides().get(tk, {})
    out.update({k: v for k, v in ov.items() if v})
    return out


def load_watchlist() -> list[str]:
    p = USER_DIR / "watchlist.json"
    if p.exists():
        return [t.upper() for t in json.loads(p.read_text())]
    return ["SPY", "QQQ", "XLK", "SMH", "NVDA", "MSFT", "AAPL", "AMZN", "JPM", "XOM"]
