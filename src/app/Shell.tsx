/** Application frame: brand, four destinations, data status, theme. */
import { useEffect, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { isFixtureMode, useHealth } from '../data/client';
import { useWorkspace } from '../data/workspace';
import { lastSymbol } from './routes';
import { openSearch, SymbolSearch } from './search';

const ICONS: Record<string, ReactNode> = {
  today: <path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" />,
  research: <path d="M3 17l5-6 4 3 6-8 3 3M3 21h18" />,
  discover: <path d="M4 5h16M7 12h10M10 19h4" />,
  portfolio: <path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8" />,
};

const Icon = ({ name }: { name: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name]}
  </svg>
);

function useDestinations() {
  const loc = useLocation();
  const sym = loc.pathname.startsWith('/research/') ? (loc.pathname.split('/')[2] ?? lastSymbol()) : lastSymbol();
  return [
    { id: 'today', to: '/', label: 'Today', end: true },
    { id: 'research', to: `/research/${sym}`, label: 'Research', end: false, match: '/research' },
    { id: 'discover', to: '/discover', label: 'Discover', end: false },
    { id: 'portfolio', to: '/portfolio', label: 'Portfolio', end: false },
  ];
}

function StatusPill() {
  const h = useHealth();
  if (h.status !== 'ready') return null;
  const bad = h.data.filter((s) => s.state !== 'ok' && s.state !== 'idle');
  return (
    <NavLink to="/data" className={`chip ${bad.length ? 'warn' : ''}`} style={{ textDecoration: 'none' }} title="Sources, as-of dates and methods">
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: bad.length ? 'var(--warn)' : 'var(--up)', display: 'inline-block' }} />
      {bad.length ? `${bad.length} source${bad.length > 1 ? 's' : ''} down` : 'Data'}
    </NavLink>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const dests = useDestinations();
  const loc = useLocation();
  const [ws, update] = useWorkspace();
  const theme = ws.settings.theme;

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const cycleTheme = () => {
    const next = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
    update((w) => ({ ...w, settings: { ...w.settings, theme: next } }));
  };

  const current = (d: (typeof dests)[number]) => (d.match ? loc.pathname.startsWith(d.match) : d.end ? loc.pathname === d.to : loc.pathname.startsWith(d.to));

  return (
    <div className="app">
      <a href="#main" className="sr-only">Skip to content</a>
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="Market Cycle Research, home">
          <img src="/mark.svg" alt="" width={26} height={26} />
          <span>Market Cycle</span>
        </NavLink>
        <nav className="nav" aria-label="Primary">
          {dests.map((d) => (
            <NavLink key={d.id} to={d.to} end={d.end} aria-current={current(d) ? 'page' : undefined}>
              {d.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <button type="button" className="btn small" onClick={openSearch} aria-label="Find a stock" title="Find a stock. Press /">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            Find
          </button>
          <StatusPill />
          <button type="button" className="icon-btn" onClick={cycleTheme} aria-label={`Theme: ${theme}. Change theme`} title={`Theme: ${theme}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              {theme === 'dark' ? <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /> : theme === 'light' ? (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
                </>
              ) : (
                <>
                  <circle cx="12" cy="12" r="8" />
                  <path d="M12 4v16" />
                  <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
                </>
              )}
            </svg>
          </button>
        </div>
      </header>
      {isFixtureMode() && (
        <div className="fixture-banner" role="note">
          Synthetic fixture data. Prices and fundamentals are generated for testing and are not market data.
        </div>
      )}
      {!isFixtureMode() && (
        <div className="fixture-banner" role="note">
          Daily closes and fundamentals from Yahoo Finance, earnings from Unusual Whales. Completed sessions only, not live quotes.
        </div>
      )}
      <main className="main" id="main">
        {children}
      </main>
      <nav className="tabbar" aria-label="Primary">
        {dests.map((d) => (
          <NavLink key={d.id} to={d.to} end={d.end} aria-current={current(d) ? 'page' : undefined}>
            <Icon name={d.id} />
            {d.label}
          </NavLink>
        ))}
      </nav>
      <SymbolSearch />
    </div>
  );
}
