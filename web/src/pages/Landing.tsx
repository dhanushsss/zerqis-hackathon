import { Fragment, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { BRAND, pageTitle } from '../brand';
import { DIAGNOSIS_INFO, DiagnosisBadge, FIX_INFO, FixBadge, Icon, useDocumentTitle, usePrefersReducedMotion } from '../components/ui';
import { MarketingPage, useHashScroll } from './marketing/MarketingLayout';
import { EvidenceLedgerPanel, UseCaseVisual, ValidationPanel } from './marketing/ProductViews';
import { SampleWalkthrough, type WalkthroughHandle } from './marketing/SampleWalkthrough';

const STEPS = [
  { icon: 'file', title: 'Understand the failure', body: 'Inspect CI logs, diffs, and repository context to identify what changed. Secret-like values are redacted before any model sees a log.' },
  { icon: 'flask', title: 'Test hypotheses', body: 'Run controlled experiments in an isolated container to distinguish competing explanations: reproduce, repeat, compare with the parent commit.' },
  { icon: 'search', title: 'Diagnose with evidence', body: 'Support or reject each hypothesis using observed execution results. "Confirmed" is held back unless the evidence is strong.' },
  { icon: 'ok', title: 'Validate a fix', body: 'Test candidate changes in a fresh environment and run the appropriate test suite before recommending them.' },
];

/** What each name in the strip actually does in this product. */
const WORKS_WITH = [
  { icon: 'github', name: 'GitHub Actions', role: 'CI runs, logs, webhooks' },
  { icon: 'flask', name: 'Jest', role: 'Experiments · JS and TypeScript' },
  { icon: 'flask', name: 'Maven', role: 'Experiments · Java' },
  { icon: 'flask', name: 'pytest', role: 'Experiments · Python' },
  { icon: 'flask', name: 'Go', role: 'Experiments · Go modules' },
  { icon: 'box', name: 'Docker', role: 'Sandboxed execution' },
  { icon: 'spark', name: 'NVIDIA Nemotron', role: 'Hypotheses and reports' },
];

const USE_CASES = [
  {
    kind: 'regression' as const,
    title: 'Code regressions',
    body: 'Reproduce at the failing commit, then run the same tests at the parent. A clean parent run points at the change; a targeted fix or revert is validated before it is suggested. TypeScript type errors re-run the type check at the failing and parent commits.',
  },
  {
    kind: 'flaky' as const,
    title: 'Flaky tests',
    body: 'Repeat the failing test many times (Jest runs use varied seeds) and report the observed failure rate with a confidence interval. Quarantining a flaky test is labelled as a containment step, not a fix for its cause.',
  },
  {
    kind: 'dependency' as const,
    title: 'Dependency incompatibilities',
    body: 'Spot dependency changes in the diff, compare against the parent build, optionally look up release notes, and validate a version pin. Go module upgrades are pinned back in go.mod and go.sum.',
  },
  {
    kind: 'rejected' as const,
    title: 'Fixes that only look correct',
    body: 'Every candidate, including model-written ones, runs in a fresh sandbox against the failing tests and the suite. A fix that fails is recorded as rejected, with its output, and never recommended.',
  },
];

const TRUST = [
  {
    icon: 'box',
    title: 'Isolated execution',
    body: 'Tests run in Docker with networking disabled, as a non-root user, with all Linux capabilities dropped, a read-only root filesystem, and CPU, memory, process, and time limits.',
  },
  {
    icon: 'settings',
    title: 'Bounded experiments',
    body: 'Commands come from fixed templates; model output is never executed. The optional agent loop chooses only from an allowlist of experiments, within budgets. Candidate fixes cannot touch CI configuration, credentials files, or version-control metadata.',
  },
  {
    icon: 'list',
    title: 'Complete evidence trail',
    body: 'Every evidence record carries its provenance: log lines, the diff, an experiment, a web source, a model call, or a policy rule. Model calls, log context, and investigation starts are budgeted and rate-limited.',
  },
];

const NOT_YET = [
  'No user accounts or authentication. Run it on a trusted machine or behind your own access controls.',
  'The sandbox is the Docker engine on the host running Zerqis, not a managed isolation service.',
  'No compliance certifications.',
  'Experiments run for Jest (JavaScript and TypeScript), Maven, pytest with root requirements files, and single-module Go projects. Other projects and layouts get log and diff analysis only.',
  'Monorepos, bundler builds, and cgo are not supported.',
  'TypeScript, pytest, and Go support is verified on controlled test repositories; it has not yet been run against real-world projects.',
];

/** Reveals [data-reveal] elements as they scroll into view. Content stays visible without IntersectionObserver or with reduced motion. */
function useReveal(root: React.RefObject<HTMLElement | null>) {
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    const el = root.current;
    if (!el || reduced || typeof IntersectionObserver === 'undefined') return;
    // Content already on screen is never faded: only content below the fold reveals on scroll.
    const fold = window.innerHeight;
    el.querySelectorAll('[data-reveal]').forEach((n) => {
      if (n.getBoundingClientRect().top < fold) n.classList.add('is-visible');
    });
    el.classList.add('reveal-on');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    el.querySelectorAll('[data-reveal]:not(.is-visible)').forEach((n) => io.observe(n));
    return () => {
      io.disconnect();
      el.classList.remove('reveal-on');
    };
  }, [root, reduced]);
}

export function Landing() {
  useDocumentTitle(pageTitle());
  useHashScroll();
  const root = useRef<HTMLDivElement>(null);
  const walkthrough = useRef<WalkthroughHandle>(null);
  useReveal(root);

  const watchSample = () => {
    const el = document.getElementById('sample');
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    el?.focus({ preventScroll: true });
    walkthrough.current?.restart();
  };

  return (
    <MarketingPage>
      <div ref={root}>
        {/* ---------------------------------------------------------------- hero */}
        <section className="mk-hero" aria-labelledby="hero-title">
          <div className="mk-container mk-hero-grid">
            <div className="mk-hero-copy">
              <span className="mk-kicker">Evidence-driven · For CI failures</span>
              <h1 id="hero-title" className="mk-h1">
                {/* Two tones, one sentence: the accessible name stays the full tagline. */}
                {BRAND.tagline.replace(/\s*Prove it\.$/, '')} <span className="mk-h1-soft">Prove it.</span>
              </h1>
              <p className="mk-lead">{BRAND.description}</p>
              <div className="mk-ctas">
                <button className="btn btn-primary btn-lg" onClick={watchSample}>
                  Watch a sample investigation <Icon name="arrowRight" />
                </button>
                <Link to="/overview" className="btn btn-lg">
                  Explore the product
                </Link>
              </div>
            </div>
            <div id="sample" tabIndex={-1} className="mk-hero-demo">
              <SampleWalkthrough ref={walkthrough} />
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------- works with */}
        <section className="mk-strip" aria-labelledby="strip-title">
          <div className="mk-container mk-strip-inner">
            <h2 id="strip-title" className="mk-strip-title">
              Works with
            </h2>
            <ul className="mk-strip-list">
              {WORKS_WITH.map((w) => (
                <li key={w.name}>
                  <Icon name={w.icon} />
                  <span className="stack-xs">
                    <span className="mk-strip-name">{w.name}</span>
                    <span className="mk-strip-role">{w.role}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mk-strip-note xs faint">
              Jest (JavaScript) and Maven are verified on the bundled sample repositories. TypeScript, pytest, and Go are verified on controlled test repositories only.
            </p>
          </div>
        </section>

        {/* ----------------------------------------------------- how it works */}
        <section id="how" className="mk-section" aria-labelledby="how-title">
          <div className="mk-container">
            <div className="mk-head" data-reveal>
              <h2 id="how-title" className="mk-h2">
                From a red build to a verified fix.
              </h2>
              <p className="mk-sub">{BRAND.name} runs a structured investigation to find the real cause and validate a working fix.</p>
            </div>
            <ol className="mk-flow">
              {STEPS.map((s, i) => (
                <Fragment key={s.title}>
                  <li className="mk-flow-step" data-reveal>
                    <span className="mk-flow-n">{String(i + 1).padStart(2, '0')}</span>
                    <span className="mk-flow-body">
                      <span className="mk-flow-icon" aria-hidden="true">
                        <Icon name={s.icon} />
                      </span>
                      <span className="stack-xs">
                        <h3>{s.title}</h3>
                        <p className="small muted">{s.body}</p>
                      </span>
                    </span>
                  </li>
                  {i < STEPS.length - 1 && (
                    <li className="mk-flow-arrow" aria-hidden="true">
                      <Icon name="arrowRight" />
                    </li>
                  )}
                </Fragment>
              ))}
            </ol>
          </div>
        </section>

        {/* --------------------------------------------------------- evidence */}
        <section id="product" className="mk-section mk-ruled" aria-labelledby="evidence-title">
          <div id="evidence" className="mk-container mk-split mk-split-wide">
            <div className="mk-split-copy" data-reveal>
              <h2 id="evidence-title" className="mk-h2 mk-h2-lg">
                See the evidence, not just the explanation.
              </h2>
              <p className="mk-sub">
                {BRAND.name} keeps the investigation trail: every observation, hypothesis, experiment result, and inference, in order, with where it came from. Follow any
                conclusion back to the runs that support it.
              </p>
              <dl className="mk-outcomes">
                <div className="stack-sm">
                  <dt className="eyebrow">Diagnosis · the cause</dt>
                  {(['CONFIRMED', 'PROBABLE', 'INCONCLUSIVE', 'BLOCKED'] as const).map((d) => (
                    <dd key={d} className="mk-outcome">
                      <DiagnosisBadge outcome={d} />
                      <span className="xs muted">{DIAGNOSIS_INFO[d].help}</span>
                    </dd>
                  ))}
                </div>
                <div className="stack-sm">
                  <dt className="eyebrow">Fix · candidate patches</dt>
                  {(['VERIFIED', 'REJECTED'] as const).map((f) => (
                    <dd key={f} className="mk-outcome">
                      <FixBadge outcome={f} />
                      <span className="xs muted">{FIX_INFO[f].help}</span>
                    </dd>
                  ))}
                </div>
              </dl>
              <div className="mk-ctas">
                <Link to="/investigations" className="btn">
                  Open investigation history <Icon name="arrowRight" />
                </Link>
              </div>
            </div>
            <div className="mk-split-visual" data-reveal>
              <EvidenceLedgerPanel />
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------- validation */}
        <section id="validation" className="mk-section mk-ruled" aria-labelledby="validation-title">
          <div className="mk-container mk-split mk-split-wide mk-split-rev">
            <div className="mk-split-visual" data-reveal>
              <ValidationPanel />
            </div>
            <div className="mk-split-copy" data-reveal>
              <h2 id="validation-title" className="mk-h2 mk-h2-lg">
                Catch the fixes that only look correct.
              </h2>
              <p className="mk-sub">
                A change can make the failing test pass and still break something else. {BRAND.name} applies each candidate to a fresh checkout, runs the failing tests several
                times, then runs the suite. A candidate that fails either step is rejected, with its output.
              </p>
              <p className="xs faint">
                A validated fix passed this repository's existing checks in a sandbox. That is evidence for the fix, not proof that it is correct in every situation.
              </p>
              <div className="mk-ctas">
                <Link to="/docs#outcomes" className="btn">
                  How results are reported <Icon name="arrowRight" />
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- use cases */}
        <section id="use-cases" className="mk-section mk-ruled" aria-labelledby="use-title">
          <div className="mk-container">
            <div className="mk-head" data-reveal>
              <h2 id="use-title" className="mk-h2">
                Built for the failures that waste the most time.
              </h2>
              <p className="mk-sub">Each example below comes from a recorded run against a bundled sample repository.</p>
            </div>
            <ul className="mk-uses">
              {USE_CASES.map((u) => (
                <li key={u.title} className="mk-use" data-reveal>
                  <UseCaseVisual kind={u.kind} />
                  <h3>{u.title}</h3>
                  <p className="small muted">{u.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ------------------------------------------------------------ trust */}
        <section id="security" className="mk-section mk-ruled" aria-labelledby="security-title">
          <div className="mk-container mk-trust-grid">
            <div className="mk-trust-copy" data-reveal>
              <h2 id="security-title" className="mk-h2">
                Built for controlled investigation.
              </h2>
              <p className="mk-sub">{BRAND.name} runs experiments in isolated environments with strict limits. Here is what is enforced today, and what is not.</p>
            </div>
            <ul className="mk-trust-cols">
              {TRUST.map((t) => (
                <li key={t.title} data-reveal>
                  <Icon name={t.icon} />
                  <h3>{t.title}</h3>
                  <p className="small muted">{t.body}</p>
                </li>
              ))}
            </ul>
            <div className="mk-notyet" data-reveal>
              <h3 className="small">Not available today</h3>
              <ul>
                {NOT_YET.map((c) => (
                  <li key={c} className="small muted">
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ final */}
        <section className="mk-section mk-final" aria-labelledby="final-title">
          <div className="mk-container mk-final-inner" data-reveal>
            <h2 id="final-title" className="mk-h2">
              Turn CI failures into answers.
            </h2>
            <p className="mk-sub">Spend less time debugging. More time building with evidence you can inspect.</p>
            <div className="mk-ctas mk-center">
              <button className="btn btn-primary btn-lg" onClick={watchSample}>
                Watch a sample investigation <Icon name="arrowRight" />
              </button>
              <Link to="/docs" className="btn btn-lg">
                Read the documentation
              </Link>
            </div>
          </div>
        </section>
      </div>
    </MarketingPage>
  );
}
