import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CardBoundary, Skeleton, StateNote } from '../ui/components';
import { ResearchLayout, ResearchRedirect } from './research';
import { lastSymbol, LEGACY_ALIASES } from './routes';
import { Shell } from './Shell';

// Each destination and research section is its own chunk. A first visit loads only what it shows.
const Today = lazy(() => import('../views/Today'));
const DataMethods = lazy(() => import('../views/DataMethods'));
const Overview = lazy(() => import('../views/research/Overview'));
const Selloffs = lazy(() => import('../views/research/Selloffs'));
const Trend = lazy(() => import('../views/research/Trend'));
const CalendarBoards = lazy(() => import('../views/research/CalendarBoards'));
const Strength = lazy(() => import('../views/research/Strength'));
const Earnings = lazy(() => import('../views/research/Earnings'));
const Business = lazy(() => import('../views/research/Business'));
const Forecasts = lazy(() => import('../views/research/Forecasts'));
const Lab = lazy(() => import('../views/research/Lab'));
const DiscoverLayout = lazy(() => import('../views/discover/DiscoverLayout'));
const Screener = lazy(() => import('../views/discover/Screener'));
const Groups = lazy(() => import('../views/discover/Groups'));
const DrawdownBoard = lazy(() => import('../views/discover/DrawdownBoard'));
const CashFlow = lazy(() => import('../views/discover/CashFlow'));
const EarningsCalendar = lazy(() => import('../views/discover/EarningsCalendar'));
const PortfolioLayout = lazy(() => import('../views/portfolio/PortfolioLayout'));
const Positions = lazy(() => import('../views/portfolio/Positions'));
const Protection = lazy(() => import('../views/portfolio/Protection'));
const Journal = lazy(() => import('../views/portfolio/Journal'));

function LegacyRedirect({ to }: { to: string }) {
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  const sym = (q.get('symbol') ?? q.get('ticker') ?? lastSymbol()).toUpperCase();
  q.delete('symbol');
  q.delete('ticker');
  const qs = q.toString();
  return <Navigate to={`${to.replace(':symbol', sym)}${qs ? `?${qs}` : ''}`} replace />;
}

function NotFound() {
  return (
    <StateNote tone="warn" title="This page does not exist.">
      Use the navigation above, or press / to find a stock.
    </StateNote>
  );
}

const S = ({ children, label }: { children: React.ReactNode; label: string }) => (
  <CardBoundary label={label}>
    <Suspense fallback={<Skeleton h={240} />}>{children}</Suspense>
  </CardBoundary>
);

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<S label="Today"><Today /></S>} />
        <Route path="/research" element={<Navigate to={`/research/${lastSymbol()}/overview`} replace />} />
        <Route path="/research/:symbol" element={<ResearchLayout />}>
          <Route index element={<ResearchRedirect />} />
          <Route path="overview" element={<S label="Overview"><Overview /></S>} />
          <Route path="selloffs" element={<S label="Selloffs"><Selloffs /></S>} />
          <Route path="trend" element={<S label="Trend"><Trend /></S>} />
          <Route path="calendar" element={<S label="Calendar"><CalendarBoards /></S>} />
          <Route path="strength" element={<S label="Strength"><Strength /></S>} />
          <Route path="earnings" element={<S label="Earnings"><Earnings /></S>} />
          <Route path="business" element={<S label="Business"><Business /></S>} />
          <Route path="forecasts" element={<S label="Forecasts"><Forecasts /></S>} />
          <Route path="lab" element={<S label="Lab"><Lab /></S>} />
          <Route path="*" element={<ResearchRedirect />} />
        </Route>
        <Route path="/discover" element={<S label="Discover"><DiscoverLayout /></S>}>
          <Route index element={<S label="Screener"><Screener /></S>} />
          <Route path="groups" element={<S label="Groups"><Groups /></S>} />
          <Route path="drawdowns" element={<S label="Drawdown board"><DrawdownBoard /></S>} />
          <Route path="cash" element={<S label="Cash flow"><CashFlow /></S>} />
          <Route path="earnings" element={<S label="Earnings calendar"><EarningsCalendar /></S>} />
        </Route>
        <Route path="/portfolio" element={<S label="Portfolio"><PortfolioLayout /></S>}>
          <Route index element={<S label="Positions"><Positions /></S>} />
          <Route path="protection" element={<S label="Protection"><Protection /></S>} />
          <Route path="journal" element={<S label="Journal"><Journal /></S>} />
        </Route>
        <Route path="/data" element={<S label="Data and methods"><DataMethods /></S>} />
        {Object.entries(LEGACY_ALIASES).map(([from, to]) => (
          <Route key={from} path={from} element={<LegacyRedirect to={to} />} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}
