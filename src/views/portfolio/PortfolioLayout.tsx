import { NavLink, Outlet } from 'react-router-dom';

const TABS = [
  { to: '/portfolio', label: 'Positions and risk', end: true },
  { to: '/portfolio/protection', label: 'Protection', end: false },
  { to: '/portfolio/journal', label: 'Journal', end: false },
];

export default function PortfolioLayout() {
  return (
    <div className="stack">
      <nav className="subnav" aria-label="Portfolio sections">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
