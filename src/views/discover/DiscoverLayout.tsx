import { NavLink, Outlet, useLocation } from 'react-router-dom';

const TABS = [
  { to: '/discover', label: 'Screener', end: true },
  { to: '/discover/groups', label: 'Groups', end: false },
  { to: '/discover/drawdowns', label: 'Drawdowns', end: false },
  { to: '/discover/cash', label: 'Cash flow', end: false },
  { to: '/discover/earnings', label: 'Earnings calendar', end: false },
];

/** Discover destination. The market cap floor travels between tabs through the URL. */
export default function DiscoverLayout() {
  const loc = useLocation();
  const cap = new URLSearchParams(loc.search).get('cap');
  return (
    <div className="stack">
      <nav className="subnav" aria-label="Discover sections">
        {TABS.map((t) => (
          <NavLink key={t.to} to={`${t.to}${cap ? `?cap=${encodeURIComponent(cap)}` : ''}`} end={t.end}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
