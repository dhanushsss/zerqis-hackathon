import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { BRAND } from './brand';
import { readiness } from './readiness';
import { RunSampleModal } from './components/RunSample';
import { Icon, ToastProvider, Wordmark } from './components/ui';
import { useApi } from './hooks';
import { Docs } from './pages/Docs';
import { ExperimentDetail } from './pages/ExperimentDetail';
import { Integrations } from './pages/Integrations';
import { InvestigationDetail } from './pages/InvestigationDetail';
import { Investigations } from './pages/Investigations';
import { Landing } from './pages/Landing';
import { Overview } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { VerifyPage } from './pages/Verify';

const SECTION: Record<string, string> = {
  overview: 'Overview',
  investigations: 'Investigations',
  verify: 'Verify a change',
  integrations: 'Integrations',
  settings: 'Settings',
  ledger: 'Evidence ledger',
  experiments: 'Experiments',
  sources: 'Sources',
  log: 'CI log',
  models: 'Model calls',
};

function Crumbs() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {parts.map((p, i) => {
        const href = `/${parts.slice(0, i + 1).join('/')}`;
        const label = SECTION[p] ?? (p.startsWith('inv_') ? `Investigation ${p.slice(-6)}` : p.startsWith('exp_') ? `Experiment ${p.slice(-6)}` : p);
        const last = i === parts.length - 1;
        return (
          <span key={href} className="row" style={{ gap: 6 }}>
            {i > 0 && <span className="sep" aria-hidden="true">/</span>}
            {last ? (
              <span className="current" aria-current="page">{label}</span>
            ) : (
              <Link to={href}>{label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function Readiness() {
  const { data } = useApi(() => api.status(), [], () => 30_000);
  if (!data) return null;
  return (
    <div className="readiness" aria-label="Integration status">
      <div className="nav-label">Integrations</div>
      {readiness(data).map((r) => (
        <Link key={r.key} to="/integrations" title={`${r.label}: ${r.state}`} className={r.ok ? 'is-ok' : r.failing ? 'is-bad' : ''}>
          <Icon name={r.ok ? 'ok' : r.failing ? 'fail' : 'skip'} className="" />
          {r.label}
          <span className="state">{r.state}</span>
        </Link>
      ))}
      {data.publicDemo && <span className="xs demo-note">Public demo · read-only</span>}
    </div>
  );
}

/** The application: sidebar navigation, top bar, and the product routes. */
function AppShell() {
  const [sampleOpen, setSampleOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
        <aside className="sidebar" id="sidebar" aria-label="Sidebar">
          <Link to="/" className="brand" aria-label={`${BRAND.name} home`}>
            <Wordmark size={26} />
          </Link>
          <p className="brand-tag">{BRAND.short}</p>
          <nav className="nav" aria-label="Main">
            <NavLink to="/overview">
              <Icon name="overview" /> Overview
            </NavLink>
            <NavLink to="/investigations">
              <Icon name="list" /> Investigations
            </NavLink>
            <NavLink to="/verify">
              <Icon name="shield" /> Verify a change
            </NavLink>
            <NavLink to="/integrations">
              <Icon name="plug" /> Integrations
            </NavLink>
            <NavLink to="/settings">
              <Icon name="settings" /> Settings
            </NavLink>
          </nav>
          <nav className="nav nav-secondary" aria-label="Resources">
            <NavLink to="/docs">
              <Icon name="file" /> Documentation
            </NavLink>
          </nav>
          <Readiness />
        </aside>
        <div className="drawer-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />
        <div className="main">
          <header className="topbar">
            <button className="btn btn-ghost btn-icon menu-btn" onClick={() => setNavOpen((o) => !o)} aria-label="Open navigation" aria-expanded={navOpen} aria-controls="sidebar">
              <Icon name="menu" />
            </button>
            <Link to="/" className="brand-mobile" aria-label={`${BRAND.name} home`}>
              <Wordmark size={22} />
            </Link>
            <Crumbs />
            <span className="spacer" />
            {/* The Overview has its own primary action; avoid two competing buttons there. */}
            {location.pathname !== '/overview' && (
              <button className="btn" onClick={() => setSampleOpen(true)} aria-label="Run sample investigation">
                <Icon name="play" /> <span className="topbar-cta-label">Run sample investigation</span>
              </button>
            )}
          </header>
          <main className="content" id="main" tabIndex={-1}>
            <Routes>
              <Route path="/overview" element={<Overview onRunSample={() => setSampleOpen(true)} />} />
              <Route path="/investigations" element={<Investigations />} />
              <Route path="/investigations/:id/experiments/:expId" element={<ExperimentDetail />} />
              <Route path="/investigations/:id/*" element={<InvestigationDetail />} />
              <Route path="/verify" element={<VerifyPage />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
        </div>
      </div>
      {sampleOpen && <RunSampleModal onClose={() => setSampleOpen(false)} />}
    </>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Routes>
        {/* Public pages: static, no API calls. */}
        <Route path="/" element={<Landing />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="*" element={<AppShell />} />
      </Routes>
    </ToastProvider>
  );
}

function NotFound() {
  return (
    <div className="card">
      <div className="empty">
        <h1 className="h-empty">Page not found</h1>
        <p>The page you requested doesn't exist.</p>
        <Link to="/overview" className="btn">
          Back to overview
        </Link>
      </div>
    </div>
  );
}
