import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Experiment, Investigation } from '../api';
import { BRAND } from '../brand';

// ------------------------------------------------------------------ icons
const P = (d: string) => <path d={d} />;
const ICONS: Record<string, ReactNode> = {
  overview: P('M3 13h7V3H3zm11 8h7V11h-7zM3 21h7v-5H3zm11-13h7V3h-7z'),
  list: P('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'),
  plug: P('M9 2v6m6-6v6M6 8h12v4a6 6 0 0 1-12 0zm6 10v4'),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      {P('M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z')}
    </>
  ),
  play: P('M7 4v16l13-8z'),
  pause: P('M8 5v14M16 5v14'),
  refresh: P('M21 12a9 9 0 1 1-3-6.7L21 8m0-5v5h-5'),
  trash: P('M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14'),
  download: P('M12 3v12m0 0-4-4m4 4 4-4M4 21h16'),
  external: P('M14 4h6v6m0-6L10 14M18 14v6H4V6h6'),
  pr: P('M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm12 6V9a3 3 0 0 0-3-3h-4m0 0 3-3m-3 3 3 3m4 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'),
  search: P('m21 21-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z'),
  check: P('m5 12 5 5L20 7'),
  x: P('M6 6l12 12M18 6 6 18'),
  menu: P('M4 6h16M4 12h16M4 18h16'),
  copy: P('M8 8h12v12H8zM4 16V4h12'),
  chevron: P('m9 6 6 6-6 6'),
  chevronLeft: P('m15 6-6 6 6 6'),
  arrowRight: P('M5 12h14m-6-6 6 6-6 6'),
  ok: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('m8 12 3 3 5-6')}
    </>
  ),
  fail: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('m9 9 6 6m0-6-6 6')}
    </>
  ),
  unsure: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('M9.5 9.5a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 2-2.4 3.4M12 17h.01')}
    </>
  ),
  pending: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('M12 7v5l3 2')}
    </>
  ),
  skip: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('M8 12h8')}
    </>
  ),
  loader: P('M12 3a9 9 0 1 0 9 9'),
  eye: (
    <>
      {P('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z')}
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  bulb: P('M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z'),
  flask: P('M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10'),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18')}
    </>
  ),
  inference: P('M4 6h7a5 5 0 0 1 5 5v9m0 0-4-4m4 4 4-4'),
  assumption: P('M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'),
  commit: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      {P('M3 12h5.5m7 0H21')}
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      {P('M6 8.5v7M18 10.5c0 4-6 3-11 6')}
    </>
  ),
  workflow: P('M4 4h6v6H4zm10 10h6v6h-6zM7 10v4a3 3 0 0 0 3 3h4'),
  file: P('M14 3H6v18h12V7zm0 0v4h4'),
  terminal: P('m4 7 5 5-5 5m8 2h8'),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('M12 7v5l3 2')}
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      {P('M4 21a8 8 0 0 1 16 0')}
    </>
  ),
  shield: P('M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z'),
  cpu: P('M7 7h10v10H7zM9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4'),
  box: P('m21 8-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8'),
  link: P('M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1m2 5a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'),
  spark: P('M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6'),
  github: P('M9 19c-4 1.5-4-2-6-2.5M15 22v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V22'),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('M12 11v5m0-8h.01')}
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  wrap: P('M3 6h18M3 12h15a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M3 18h7'),
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, className, label }: { name: string; className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ico ${className ?? ''}`}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {ICONS[name]}
    </svg>
  );
}

// ------------------------------------------------------------------ brand
/** The Zerqis mark: a Z whose path ends in a verified point. Same drawing as /favicon.svg. */
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--logo-tile, #0d1311)" />
      <path d="M10 10.5h12L10 21.5h8" fill="none" stroke="var(--logo-stroke, #fff)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="22.4" cy="21.5" r="2.3" fill="var(--logo-dot, #10b981)" />
    </svg>
  );
}

/** Mark plus product name. The name comes from brand.ts. */
export function Wordmark({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`wordmark ${className}`}>
      <Logo size={size} />
      <span className="wordmark-name">{BRAND.name}</span>
    </span>
  );
}

/** True when the user asked the OS to minimise motion. */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** Sets document.title for the lifetime of the calling page. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

// ------------------------------------------------------------------ motion
/**
 * True for a short moment after `value` changes in a way `shouldFlash` accepts.
 * Never fires on first render, so already-finished results are not re-animated.
 */
export function useChangeFlash<T>(value: T, shouldFlash: (prev: T, next: T) => boolean = (a, b) => a !== b, ms = 1400): boolean {
  const prev = useRef(value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (before !== value && shouldFlash(before, value)) {
      setOn(true);
      const t = setTimeout(() => setOn(false), ms);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return on;
}

// ------------------------------------------------------------------ labels
export const CLASS_LABEL: Record<string, string> = {
  code_regression: 'Code regression',
  flaky_test: 'Flaky test',
  infrastructure: 'Infrastructure',
  dependency_regression: 'Dependency regression',
  external_outage: 'External outage',
  unknown: 'Unknown cause',
};

export const KIND: Record<string, { label: string; icon: string; tone: string; help: string }> = {
  observed_fact: { label: 'Observed fact', icon: 'eye', tone: 'tone-outline', help: 'Read directly from the CI log, git, or a provider API.' },
  model_hypothesis: { label: 'Hypothesis', icon: 'bulb', tone: 'tone-model', help: 'Proposed by a model or heuristic rules. A claim to test, not a fact.' },
  experiment_result: { label: 'Experiment result', icon: 'flask', tone: 'tone-pass', help: 'Produced by executing code in the sandbox.' },
  external_source: { label: 'External source', icon: 'globe', tone: 'tone-web', help: 'Retrieved by Tavily web search. A lead, not proof.' },
  inference: { label: 'Inference', icon: 'inference', tone: 'tone-warn', help: 'A conclusion drawn from other records by rules or a model.' },
  assumption: { label: 'Assumption', icon: 'assumption', tone: 'tone-dashed', help: 'Taken as given and not verified.' },
};

export const EXP_KIND: Record<string, string> = {
  reproduce: 'Reproduce',
  repeat: 'Repeat',
  compare_parent: 'Parent comparison',
  external_search: 'External search',
  validate_patch: 'Fix validation',
  regression_suite: 'Regression suite',
};

export const MODE_INFO: Record<string, { label: string; tone: string; icon: string; help: string }> = {
  live: { label: 'Live Nemotron', tone: 'tone-model', icon: 'spark', help: 'Model stages called NVIDIA Nemotron through Nebius Token Factory during this run.' },
  replay: { label: 'Replay', tone: 'tone-warn', icon: 'refresh', help: 'Model stages re-used outputs recorded from an earlier live Nemotron run. Experiments executed live.' },
  heuristic: { label: 'Heuristic', tone: 'tone-neutral', icon: 'list', help: 'No model was used; model stages ran deterministic rules. Experiments executed live.' },
};

// ------------------------------------------------------------------ badges
export function Badge({ tone = 'tone-neutral', icon, children, title, lg, className = '' }: { tone?: string; icon?: string; children: ReactNode; title?: string; lg?: boolean; className?: string }) {
  return (
    <span className={`badge ${tone} ${lg ? 'lg' : ''} ${className}`} title={title}>
      {icon && <Icon name={icon} className={icon === 'loader' ? 'spin' : undefined} />}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: Investigation['status'] }) {
  const map: Record<string, [string, string, string]> = {
    queued: ['tone-neutral', 'pending', 'Queued'],
    running: ['tone-info', 'loader', 'Running'],
    // Finishing a run is not a verified outcome; green is reserved for confirmed causes and validated fixes.
    completed: ['tone-outline', 'check', 'Completed'],
    inconclusive: ['tone-warn', 'unsure', 'Inconclusive'],
    failed: ['tone-fail', 'fail', 'Failed'],
  };
  const [tone, icon, label] = map[status] ?? ['tone-neutral', 'info', status];
  return (
    <Badge tone={tone} icon={icon}>
      {label}
    </Badge>
  );
}

export function VerdictBadge({ verdict, lg }: { verdict: Investigation['verdict']; lg?: boolean }) {
  if (!verdict) return <span className="faint small">No verdict</span>;
  const [tone, icon] = verdict === 'confirmed' ? ['tone-pass', 'ok'] : verdict === 'probable' ? ['tone-info', 'target'] : ['tone-warn', 'unsure'];
  return (
    <Badge tone={tone} icon={icon} lg={lg}>
      {verdict[0].toUpperCase() + verdict.slice(1)}
    </Badge>
  );
}

/** Verdict plus confidence on one line (tables). */
export function VerdictCell({ verdict, confidence }: { verdict: Investigation['verdict']; confidence?: string | null }) {
  if (!verdict) return <span className="faint small">No verdict</span>;
  return (
    <span className="row nowrap" style={{ gap: 6 }}>
      <VerdictBadge verdict={verdict} />
      {confidence && <span className="xs muted">{confidence}</span>}
    </span>
  );
}

export function ClassBadge({ value }: { value: string | null }) {
  if (!value) return <span className="faint small">—</span>;
  return <Badge tone="tone-outline">{CLASS_LABEL[value] ?? value}</Badge>;
}

export function ConfidenceBadge({ label }: { label?: string | null }) {
  if (!label) return null;
  const tone = label === 'strong' ? 'tone-pass' : label === 'moderate' ? 'tone-info' : label === 'weak' ? 'tone-warn' : 'tone-neutral';
  return (
    <Badge tone={tone} title="Derived from which experiments ran and what they showed">
      {label[0].toUpperCase() + label.slice(1)} evidence
    </Badge>
  );
}

type AgentOutcome = NonNullable<Investigation['agent']>;

/** Display only: the outcome value is decided by the backend outcome rules. */
export const DIAGNOSIS_INFO: Record<AgentOutcome['diagnosis'], { label: string; tone: string; icon: string; help: string }> = {
  CONFIRMED: { label: 'Cause confirmed', tone: 'tone-pass', icon: 'ok', help: 'The experiments confirmed the cause. This says nothing about whether a fix works.' },
  PROBABLE: { label: 'Cause probable', tone: 'tone-info', icon: 'target', help: 'The evidence favours this cause but does not confirm it.' },
  INCONCLUSIVE: { label: 'Cause inconclusive', tone: 'tone-warn', icon: 'unsure', help: 'Experiments ran but did not discriminate between the hypotheses.' },
  BLOCKED: { label: 'Diagnosis blocked', tone: 'tone-warn', icon: 'assumption', help: 'Evidence could not be gathered (no sandbox run, or every proposed experiment was rejected by policy).' },
};

export const FIX_INFO: Record<AgentOutcome['fix'], { label: string; tone: string; icon: string; help: string }> = {
  VERIFIED: { label: 'Fix verified', tone: 'tone-pass', icon: 'ok', help: 'At least one candidate fix passed validation in a fresh sandbox.' },
  REJECTED: { label: 'Fixes rejected', tone: 'tone-fail', icon: 'fail', help: 'Every candidate fix failed validation. Do not apply them.' },
  NONE: { label: 'No validated fix', tone: 'tone-neutral', icon: 'pending', help: 'No candidate fix passed validation.' },
};

export function DiagnosisBadge({ outcome }: { outcome: AgentOutcome['diagnosis'] }) {
  const d = DIAGNOSIS_INFO[outcome] ?? { label: outcome, tone: 'tone-neutral', icon: 'info', help: '' };
  return (
    <Badge tone={d.tone} icon={d.icon} title={d.help}>
      {d.label}
    </Badge>
  );
}

export function FixBadge({ outcome }: { outcome: AgentOutcome['fix'] }) {
  const f = FIX_INFO[outcome] ?? { label: outcome, tone: 'tone-neutral', icon: 'info', help: '' };
  return (
    <Badge tone={f.tone} icon={f.icon} title={f.help}>
      {f.label}
    </Badge>
  );
}

/** The backend decides the reasoning mode after evidence collection; before that the stored value is a placeholder. */
export function modeDecided(inv: Pick<Investigation, 'status' | 'stage'>): boolean {
  return !(inv.status === 'queued' || (inv.status === 'running' && /^(Queued|Collecting)/.test(inv.stage)));
}

export function ModeBadge({ mode, pending = false }: { mode: string; pending?: boolean }) {
  if (pending) {
    return (
      <Badge tone="tone-neutral" icon="pending" title="The reasoning mode is chosen once the CI evidence has been collected.">
        Mode pending
      </Badge>
    );
  }
  const m = MODE_INFO[mode] ?? { label: mode, tone: 'tone-neutral', icon: 'info', help: '' };
  return (
    <Badge tone={m.tone} icon={m.icon} title={m.help}>
      {m.label}
    </Badge>
  );
}

export function HypStatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string, string]> = {
    supported: ['tone-pass', 'ok', 'Supported'],
    refuted: ['tone-fail', 'fail', 'Contradicted'],
    inconclusive: ['tone-warn', 'unsure', 'Inconclusive'],
    open: ['tone-neutral', 'pending', 'Untested'],
  };
  const [tone, icon, label] = map[status] ?? map.open;
  return (
    <Badge tone={tone} icon={icon}>
      {label}
    </Badge>
  );
}

export function ExpStatus({ exp, withLabel = false }: { exp: Pick<Experiment, 'status' | 'kind' | 'backend'>; withLabel?: boolean }) {
  // For test experiments, "failed" means the tests failed (an observation), not that the experiment broke.
  const map: Record<string, [string, string, string]> = {
    passed: ['var(--ok)', 'ok', exp.kind === 'external_search' ? 'Completed' : 'Tests passed'],
    failed: ['var(--fail)', 'fail', 'Tests failed'],
    error: ['var(--warn)', 'assumption', 'Could not run'],
    running: ['var(--info)', 'loader', 'Running'],
    queued: ['var(--text-3)', 'pending', 'Queued'],
    skipped: ['var(--text-3)', 'skip', 'Skipped'],
  };
  const [color, icon, label] = map[exp.status] ?? map.queued;
  return (
    <span className="row" style={{ color, gap: 6 }} title={label}>
      <Icon name={icon} className={exp.status === 'running' ? 'spin' : undefined} label={withLabel ? undefined : label} />
      {withLabel && <span className="small strong">{label}</span>}
    </span>
  );
}

export function Sha({ sha, n = 7, to }: { sha: string | null | undefined; n?: number; to?: string }) {
  if (!sha) return <span className="faint">—</span>;
  if (to) {
    return (
      <a className="sha" href={to} target="_blank" rel="noreferrer" title={sha}>
        {sha.slice(0, n)}
      </a>
    );
  }
  return (
    <span className="sha" title={sha}>
      {sha.slice(0, n)}
    </span>
  );
}

// ------------------------------------------------------------------ time
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function TimeAgo({ iso }: { iso: string | null | undefined }) {
  return (
    <time dateTime={iso ?? undefined} title={iso ? new Date(iso).toLocaleString() : undefined}>
      {timeAgo(iso)}
    </time>
  );
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

// ------------------------------------------------------------------ experiments
export function AttemptStrip({ exp, large = false, selected, onSelect }: { exp: Experiment; large?: boolean; selected?: number | null; onSelect?: (index: number) => void }) {
  const done = exp.result?.attempts ?? [];
  const planned = Math.max(exp.plannedAttempts, done.length);
  const cells = Array.from({ length: planned }, (_, i) => done[i]);
  const passed = done.filter((a) => a.passed).length;
  // Index from which runs arrived after this view mounted; earlier runs are not animated.
  const seen = useRef<number | null>(null);
  const arrivedFrom = seen.current ?? done.length;
  useEffect(() => {
    seen.current = done.length;
  });
  return (
    <span className={`attempts ${large ? 'lg' : ''}`} role={large ? 'group' : 'img'} aria-label={`${passed} passed, ${done.length - passed} failed of ${planned} planned runs`}>
      {cells.map((a, i) => {
        const cls = `${a ? (a.passed ? 'pass' : 'fail') : exp.status === 'running' && i === done.length ? 'running' : 'pending'}${a && i >= arrivedFrom ? ' arrived' : ''}`;
        const title = a ? `Run ${a.index}: ${a.passed ? 'passed' : 'failed'}${a.seed !== undefined ? ` · seed ${a.seed}` : ''} · exit ${a.exitCode ?? '—'} · ${duration(a.durationMs)}` : exp.status === 'running' && i === done.length ? 'Running' : 'Not run';
        if (large && a && onSelect) {
          return (
            <button key={i} type="button" className={`attempt ${cls}`} title={title} aria-pressed={selected === a.index} aria-label={title} onClick={() => onSelect(a.index)}>
              {a.index}
            </button>
          );
        }
        return (
          <span key={i} className={`attempt ${cls}`} title={title}>
            {large ? (a ? a.index : i + 1) : null}
          </span>
        );
      })}
    </span>
  );
}

// ------------------------------------------------------------------ code surfaces
export function CopyButton({ text, label = 'Copy', className = 'btn btn-sm' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('ok');
    } catch {
      setState('err');
    }
    setTimeout(() => setState('idle'), 1600);
  };
  return (
    // Icon-only variants (empty label) still need an accessible name.
    <button type="button" className={className} onClick={copy} aria-live="polite" aria-label={label ? undefined : state === 'ok' ? 'Copied' : 'Copy to clipboard'}>
      <Icon name={state === 'ok' ? 'check' : 'copy'} />
      {state === 'ok' ? 'Copied' : state === 'err' ? 'Copy failed' : label}
    </button>
  );
}

export function CodeBlock({ text }: { text: string }) {
  return (
    <div className="codeblock">
      {text}
      <span className="copy">
        <CopyButton text={text} label="" className="btn btn-sm btn-ghost btn-icon" />
      </span>
    </div>
  );
}

const ANSI = /\u001b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/** Read-only terminal. Content is rendered as text (never HTML). */
export function Terminal({ text, title, meta }: { text: string; title?: ReactNode; meta?: ReactNode }) {
  const [wrap, setWrap] = useState(false);
  const clean = useMemo(() => stripAnsi(text), [text]);
  const lines = clean.split('\n');
  return (
    <div className={`terminal ${wrap ? 'wrap' : ''}`}>
      <div className="terminal-bar">
        <Icon name="terminal" className="" />
        <span className="strong" style={{ color: '#e4e8ee' }}>
          {title}
        </span>
        {meta}
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => setWrap((w) => !w)} aria-pressed={wrap}>
          <Icon name="wrap" /> {wrap ? 'No wrap' : 'Wrap'}
        </button>
        <CopyButton text={clean} />
      </div>
      <pre tabIndex={0} aria-label={typeof title === 'string' ? title : 'Terminal output'}>
        {lines.map((l, i) => {
          const cls = /✕|●|FAIL\b|ERROR|Error:|AssertionError|BUILD FAILURE|cannot find symbol|^\s*[-]\s{1,3}\S|exit code [1-9]/.test(l)
            ? 'ln-err'
            : /✓|PASS\b|BUILD SUCCESS|Tests run:.*Failures: 0, Errors: 0/.test(l)
              ? 'ln-ok'
              : /^\s*at /.test(l)
                ? 'ln-dim'
                : '';
          return (
            <span key={i} className={cls}>
              {l}
              {'\n'}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

/** Unified diff with old/new line numbers. */
export function DiffView({ diff, flash = false }: { diff: string; flash?: boolean }) {
  const rows: Array<{ cls: string; o?: number; n?: number; m: string; t: string }> = [];
  let o = 0;
  let n = 0;
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git')) {
      rows.push({ cls: 'file', m: '', t: line.replace(/^diff --git a\/(\S+) b\/\S+$/, '$1') });
    } else if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      continue;
    } else if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      o = m ? Number(m[1]) : o;
      n = m ? Number(m[2]) : n;
      rows.push({ cls: 'hunk', m: '', t: line });
    } else if (line.startsWith('+')) {
      rows.push({ cls: 'add', n: n++, m: '+', t: line.slice(1) });
    } else if (line.startsWith('-')) {
      rows.push({ cls: 'del', o: o++, m: '−', t: line.slice(1) });
    } else if (line.startsWith('\\')) {
      rows.push({ cls: 'ctx', m: '', t: line });
    } else {
      rows.push({ cls: 'ctx', o: o++, n: n++, m: '', t: line.slice(1) });
    }
  }
  const adds = rows.filter((r) => r.cls === 'add').length;
  const dels = rows.filter((r) => r.cls === 'del').length;
  return (
    <div className={`diff ${flash ? 'diff-flash' : ''}`} role="region" aria-label={`Patch diff, ${adds} additions and ${dels} deletions`} tabIndex={0}>
      <table>
        <tbody>
          {rows.map((r, i) =>
            r.cls === 'file' || r.cls === 'hunk' ? (
              <tr key={i} className={r.cls}>
                <td colSpan={4} className="t">
                  {r.t}
                </td>
              </tr>
            ) : (
              <tr key={i} className={r.cls}>
                <td className="g">{r.o ?? ''}</td>
                <td className="g">{r.n ?? ''}</td>
                <td className="m">{r.m}</td>
                <td className="t">{r.t || ' '}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ states
export function Empty({ title, icon = 'info', children }: { title: string; icon?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Callout({ tone = '', icon = 'info', children }: { tone?: string; icon?: string; children: ReactNode }) {
  return (
    <div className={`callout ${tone}`}>
      <Icon name={icon} />
      <div className="stack-xs" style={{ minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const hint = (error as Error & { hint?: string }).hint;
  return (
    <div className="callout tone-fail" role="alert" style={{ background: 'var(--fail-soft)', borderColor: 'var(--fail-line)' }}>
      <Icon name="fail" />
      <div className="stack-xs" style={{ flex: 1 }}>
        <span>
          <strong>Something went wrong.</strong> {error.message}
        </span>
        {hint && <span className="small muted">{hint}</span>}
      </div>
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Loading({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="stack-sm" aria-busy="true" aria-label={label} role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 16, width: `${92 - i * 11}%` }} />
      ))}
    </div>
  );
}

export function SectionHead({ title, hint, action, id }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="section-head">
      <div className="row-wrap" style={{ alignItems: 'baseline', gap: 10 }}>
        <h2 id={id}>{title}</h2>
        {hint && <span className="hint">{hint}</span>}
      </div>
      {action}
    </div>
  );
}

export function InternalLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={className}>
      {children}
    </Link>
  );
}

// ------------------------------------------------------------------ toast
type Toast = { id: number; text: string; error?: boolean };
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const show = useCallback((text: string, error = false) => {
    const id = Date.now();
    setToast({ id, text, error });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 5500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div aria-live="polite" role="status">
        {toast && (
          <div className={`toast ${toast.error ? 'error' : ''}`}>
            <Icon name={toast.error ? 'fail' : 'ok'} />
            <span>{toast.text}</span>
          </div>
        )}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
