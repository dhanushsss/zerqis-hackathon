import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BRAND } from '../../brand';
import { Icon, Wordmark } from '../../components/ui';
import '../../marketing.css';

/** Landing-page sections, addressable from any marketing page as "/#id". */
export const SECTIONS = [
  { id: 'product', label: 'Product' },
  { id: 'how', label: 'How it works' },
  { id: 'use-cases', label: 'Use cases' },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {SECTIONS.map((s) => (
        <Link key={s.id} to={{ pathname: '/', hash: `#${s.id}` }} onClick={onNavigate}>
          {s.label}
        </Link>
      ))}
      <Link to="/docs" onClick={onNavigate}>
        Documentation
      </Link>
    </>
  );
}

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.hash]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className={`mk-nav ${open ? 'is-open' : ''}`}>
      <div className="mk-container mk-nav-inner">
        <Link to="/" className="mk-brand" aria-label={`${BRAND.name} home`}>
          <Wordmark size={26} />
        </Link>
        <nav className="mk-nav-links" aria-label="Site">
          <NavLinks />
        </nav>
        <span className="spacer" />
        <Link to="/overview" className="btn btn-primary mk-nav-cta">
          Open the app <Icon name="arrowRight" />
        </Link>
        <button className="btn btn-ghost btn-icon mk-menu-btn" aria-label="Open site menu" aria-expanded={open} aria-controls="mk-menu" onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? 'x' : 'menu'} />
        </button>
      </div>
      {open && (
        <nav id="mk-menu" className="mk-menu" aria-label="Site menu">
          <NavLinks onNavigate={() => setOpen(false)} />
          <Link to="/overview" className="btn btn-primary">
            Open the app
          </Link>
        </nav>
      )}
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="mk-footer">
      <div className="mk-container mk-footer-inner">
        <div className="mk-footer-brand">
          <Wordmark size={22} />
          <span className="small muted">{BRAND.short}</span>
        </div>
        <nav className="mk-footer-links" aria-label="Footer">
          {SECTIONS.map((s) => (
            <Link key={s.id} to={{ pathname: '/', hash: `#${s.id}` }}>
              {s.label}
            </Link>
          ))}
          <Link to="/docs">Documentation</Link>
          <Link to="/overview">Open the app</Link>
        </nav>
      </div>
      <div className="mk-container mk-footer-legal xs faint">Open source under the MIT License.</div>
    </footer>
  );
}

/** Scrolls to the element named by the URL hash, also when the hash changes on the same page. */
export function useHashScroll(ready = true) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready) return;
    if (!hash) {
      window.scrollTo?.({ top: 0 });
      return;
    }
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el) return;
    el.scrollIntoView?.({ block: 'start' });
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }, [hash, ready]);
}

export function MarketingPage({ children }: { children: ReactNode }) {
  return (
    <div className="mk">
      <a className="skip-link" href="#mk-main">
        Skip to content
      </a>
      <MarketingNav />
      <main id="mk-main" tabIndex={-1}>
        {children}
      </main>
      <MarketingFooter />
    </div>
  );
}
