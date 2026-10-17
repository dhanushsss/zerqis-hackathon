import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { readiness } from './readiness';
import { RunSampleModal } from './components/RunSample';
import { Icon, ToastProvider } from './components/ui';
import { useApi } from './hooks';
import { ExperimentDetail } from './pages/ExperimentDetail';
import { Integrations } from './pages/Integrations';
import { InvestigationDetail } from './pages/InvestigationDetail';
import { Investigations } from './pages/Investigations';
import { Overview } from './pages/Overview';
import { SettingsPage } from './pages/Settings';

const SECTION: Record<string, string> = {
  investigations: 'Investigations',
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
  if (!parts.length) return <div className="crumbs"><span className="current">Overview</span></div>;
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
      {data.publicDemo && <span className="xs" style={{ color: 'var(--ink-muted)', padding: '6px 10px' }}>Public demo · read-only</span>}
    </div>
  );
}

export function App() {
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
    <ToastProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
        <aside className="sidebar" id="sidebar" aria-label="Sidebar">
          <Link to="/" className="brand" aria-label="Alibi home">
            <img src="/favicon.svg" alt="" />
            <span className="brand-name">Alibi</span>
          </Link>
          <p className="brand-tag">CI failure forensics. Proves why builds fail.</p>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>
              <Icon name="overview" /> Overview
            </NavLink>
            <NavLink to="/investigations">
              <Icon name="list" /> Investigations
            </NavLink>
            <NavLink to="/integrations">
              <Icon name="plug" /> Integrations
            </NavLink>
            <NavLink to="/settings">
              <Icon name="settings" /> Settings
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
            <Link to="/" className="brand-mobile" aria-label="Alibi home">
              <img src="/favicon.svg" alt="" /> Alibi
            </Link>
            <Crumbs />
            <span className="spacer" />
            {/* The Overview has its own primary action; avoid two competing buttons there. */}
            {location.pathname !== '/' && (
              <button className="btn" onClick={() => setSampleOpen(true)} aria-label="Run sample investigation">
                <Icon name="play" /> <span className="topbar-cta-label">Run sample investigation</span>
              </button>
            )}
          </header>
          <main className="content" id="main" tabIndex={-1}>
            <Routes>
              <Route path="/" element={<Overview onRunSample={() => setSampleOpen(true)} />} />
              <Route path="/investigations" element={<Investigations />} />
              <Route path="/investigations/:id/experiments/:expId" element={<ExperimentDetail />} />
              <Route path="/investigations/:id/*" element={<InvestigationDetail />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
        </div>
      </div>
      {sampleOpen && <RunSampleModal onClose={() => setSampleOpen(false)} />}
    </ToastProvider>
  );
}

function NotFound() {
  return (
    <div className="card">
      <div className="empty">
        <h3>Page not found</h3>
        <p>The page you requested doesn't exist.</p>
        <Link to="/" className="btn">
          Back to overview
        </Link>
      </div>
    </div>
  );
}
