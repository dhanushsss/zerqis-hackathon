import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Bundle } from '../../api';
import { BRAND } from '../../brand';
import { AttemptStrip, Badge, CLASS_LABEL, Icon, KIND, Sha, useChangeFlash } from '../../components/ui';
import { buildEvidencePath, COLUMN_TITLE, edgesFor, validationExperiments, type EvidencePathModel, type PathNode, type PathState } from './evidencePathModel';

const STATE: Record<PathState, { label: string; icon: string; tone: string }> = {
  observed: { label: 'Observed', icon: 'eye', tone: 'neutral' },
  supported: { label: 'Supported', icon: 'ok', tone: 'pass' },
  contradicted: { label: 'Contradicted', icon: 'fail', tone: 'fail' },
  unresolved: { label: 'Unresolved', icon: 'unsure', tone: 'warn' },
  untested: { label: 'Not yet tested', icon: 'pending', tone: 'neutral' },
  tests_passed: { label: 'Tests passed', icon: 'ok', tone: 'pass' },
  tests_failed: { label: 'Tests failed', icon: 'fail', tone: 'fail' },
  intermittent: { label: 'Intermittent', icon: 'unsure', tone: 'warn' },
  completed: { label: 'Search completed', icon: 'globe', tone: 'info' },
  skipped: { label: 'Skipped', icon: 'skip', tone: 'skipped' },
  error: { label: 'Could not run', icon: 'assumption', tone: 'warn' },
  running: { label: 'Running', icon: 'loader', tone: 'info' },
  queued: { label: 'Queued', icon: 'pending', tone: 'neutral' },
  confirmed: { label: 'Confirmed', icon: 'ok', tone: 'pass' },
  probable: { label: 'Probable', icon: 'target', tone: 'info' },
  inconclusive: { label: 'Inconclusive', icon: 'unsure', tone: 'warn' },
  no_verdict: { label: 'No verdict yet', icon: 'pending', tone: 'neutral' },
  validated: { label: 'Validated fix', icon: 'ok', tone: 'pass' },
  validation_failed: { label: 'Validation failed', icon: 'fail', tone: 'fail' },
  validating: { label: 'Validating', icon: 'loader', tone: 'info' },
  proposed: { label: 'Proposed · not validated', icon: 'pending', tone: 'neutral' },
};

const KIND_LABEL: Record<PathNode['kind'], string> = {
  log: 'CI log',
  observed_fact: KIND.observed_fact.label,
  hypothesis: 'Hypothesis (claim)',
  experiment: 'Experiment',
  verdict: 'Diagnosis',
  patch: 'Candidate fix',
};

/** Moves focus to an existing card on this page and briefly marks it. User-initiated only. */
function focusRecord(elementId: string) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
  el.classList.remove('focus-flash');
  void el.offsetWidth;
  el.classList.add('focus-flash');
  window.setTimeout(() => el.classList.remove('focus-flash'), 1600);
}

function NodeButton({ n, col, row, selected, related, dimmed, b, onSelect }: { n: PathNode; col: number; row: number; selected: boolean; related: boolean; dimmed: boolean; b: Bundle; onSelect: () => void }) {
  const s = STATE[n.state];
  // Animate only a recorded state change observed while the page is open.
  const changed = useChangeFlash(n.state);
  const exp = n.kind === 'experiment' ? b.experiments.find((e) => e.id === n.refId) : undefined;
  return (
    <button
      type="button"
      className={`pnode t-${s.tone} ${selected ? 'is-selected' : ''} ${related ? 'is-related' : ''} ${dimmed ? 'is-dim' : ''} ${changed ? 'changed' : ''}`}
      aria-pressed={selected}
      aria-label={`${COLUMN_TITLE[n.column]}: ${n.title}. ${s.label}. ${n.summary}`}
      data-col={col}
      data-row={row}
      onClick={onSelect}
    >
      <span className="pnode-state">
        <Icon name={s.icon} className={n.state === 'running' || n.state === 'validating' ? 'spin' : undefined} />
        {s.label}
      </span>
      <span className="pnode-title">{n.title}</span>
      <span className="pnode-summary">{n.summary}</span>
      {exp && exp.backend === 'docker' && exp.plannedAttempts > 0 && <AttemptStrip exp={exp} />}
    </button>
  );
}

function Details({ model, node, b, onSelect }: { model: EvidencePathModel; node: PathNode; b: Bundle; onSelect: (id: string) => void }) {
  const inv = b.investigation;
  const base = `/investigations/${inv.id}`;
  const s = STATE[node.state];
  const all = model.columns.flatMap((c) => c.nodes);
  const rel = edgesFor(model, node.id);
  const seqOf = (id: string | null) => (id ? b.evidence.find((e) => e.id === id)?.seq : undefined);

  let body: ReactNode = null;
  let actions: ReactNode = null;
  if (node.kind === 'log') {
    body = (
      <>
        <div className="signature">{inv.failureSignature ?? 'Signature not extracted yet.'}</div>
        <p className="small muted">
          Commit <Sha sha={inv.commitSha} n={10} /> · parsed deterministically from the {inv.change ? 'sandbox test output' : 'CI log'}{inv.logStats ? ` (${inv.logStats.totalLines.toLocaleString()} lines)` : ''}.
        </p>
      </>
    );
    actions = (
      <Link className="btn btn-sm" to={`${base}/log`}>
        <Icon name="terminal" /> {inv.change ? 'Open test output' : 'Open CI log'}
      </Link>
    );
  } else if (node.kind === 'observed_fact') {
    const ev = b.evidence.find((e) => e.id === node.refId);
    body = <p className="small muted ep-pre">{ev?.detail || node.summary}</p>;
    actions = (
      <>
        <Link className="btn btn-sm" to={`${base}/ledger#${node.refId}`}>
          <Icon name="list" /> Ledger record #{ev?.seq}
        </Link>
        {ev?.provenance.lines && (
          <Link className="btn btn-sm" to={`${base}/log?line=${ev.provenance.lines[0]}&to=${ev.provenance.lines[1]}`}>
            <Icon name="file" /> CI log L{ev.provenance.lines[0]}
          </Link>
        )}
      </>
    );
  } else if (node.kind === 'hypothesis') {
    const h = b.hypotheses.find((x) => x.id === node.refId)!;
    body = (
      <p className="small">
        {h.cause} <span className="muted">· {CLASS_LABEL[h.category]} · {h.origin === 'model' ? 'model-generated' : h.origin === 'replay' ? 'model output (replay)' : 'heuristic rules'}</span>
      </p>
    );
    actions = (
      <>
        <button type="button" className="btn btn-sm" onClick={() => focusRecord(`hyp-card-${h.key}`)}>
          <Icon name="arrowRight" /> Show hypothesis
        </button>
        <Link className="btn btn-sm" to={`${base}/ledger?hyp=${h.key}`}>
          <Icon name="list" /> Ledger records for {h.key}
        </Link>
      </>
    );
  } else if (node.kind === 'experiment') {
    const e = b.experiments.find((x) => x.id === node.refId)!;
    const result = b.evidence.find((x) => x.kind === 'experiment_result' && x.experimentId === e.id);
    body = (
      <div className="stack-xs small">
        <span>{e.observation ?? e.reason}</span>
        {e.commitSha && (
          <span className="muted">
            Commit <Sha sha={e.commitSha} /> {e.commitSha === inv.parentSha ? '(parent)' : '(failing)'} · {e.testSelection ?? '—'}
          </span>
        )}
      </div>
    );
    actions = (
      <>
        <Link className="btn btn-sm" to={`${base}/experiments/${e.id}`}>
          <Icon name="flask" /> Open experiment
        </Link>
        {result && (
          <Link className="btn btn-sm" to={`${base}/ledger#${result.id}`}>
            <Icon name="list" /> Ledger record #{result.seq}
          </Link>
        )}
      </>
    );
  } else if (node.kind === 'verdict') {
    body = (
      <div className="stack-xs small">
        {inv.verdict ? (
          <>
            <span>
              {CLASS_LABEL[inv.classification ?? 'unknown']}
              {inv.confidence ? ` · ${inv.confidence.label} evidence (rubric, not a probability)` : ''}
            </span>
            {inv.confidence && (
              <ul className="basis">
                {inv.confidence.basis.slice(0, 4).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
            <span className="muted">A diagnosis is about the cause. Whether a fix works is shown separately under Remediation.</span>
          </>
        ) : (
          <span className="muted">{BRAND.name} issues no verdict until experiments have run.</span>
        )}
      </div>
    );
    actions = (
      <button type="button" className="btn btn-sm" onClick={() => focusRecord('verdict-card')}>
        <Icon name="arrowRight" /> Show verdict and evidence
      </button>
    );
  } else if (node.kind === 'patch') {
    const p = b.patches.find((x) => x.id === node.refId)!;
    const runs = validationExperiments(b, p);
    body = (
      <div className="stack-xs small">
        <span>{p.validation?.summary ?? 'No test has run against this patch yet.'}</span>
        {runs.map((e) => (
          <Link key={e.id} to={`${base}/experiments/${e.id}`} className="row" style={{ gap: 8 }}>
            <AttemptStrip exp={e} /> {e.kind === 'regression_suite' ? 'Regression suite' : 'Targeted validation'}
          </Link>
        ))}
      </div>
    );
    actions = (
      <button type="button" className="btn btn-sm" onClick={() => focusRecord(`patch-card-${p.id}`)}>
        <Icon name="arrowRight" /> Show fix and diff
      </button>
    );
  }

  return (
    <div className="epath-detail" aria-live="polite">
      <div className="stack-sm" style={{ minWidth: 0 }}>
        <div className="row-wrap">
          <span className="eyebrow">{KIND_LABEL[node.kind]}</span>
          <Badge tone={`tone-${s.tone === 'skipped' ? 'neutral' : s.tone === 'neutral' ? 'neutral' : s.tone}`} icon={s.icon}>
            {s.label}
          </Badge>
        </div>
        <h3 className="wrap-any">{node.title}</h3>
        {body}
        <div className="row-wrap">{actions}</div>
      </div>
      <div className="stack-xs" style={{ minWidth: 0 }}>
        <span className="eyebrow">Recorded relationships</span>
        {rel.length === 0 ? (
          <p className="small muted">None recorded for this step.</p>
        ) : (
          <ul className="ep-rel">
            {rel.map((e) => {
              const otherId = e.from === node.id ? e.to : e.from;
              const other = all.find((x) => x.id === otherId)!;
              const seq = seqOf(e.evidenceId);
              const phrase = e.from === node.id ? `${e.label} →` : `← ${e.label}`;
              return (
                <li key={e.id} className={`r-${e.relation}`}>
                  <span className="ep-rel-label">{phrase}</span>
                  <button type="button" className="e-more" onClick={() => onSelect(other.id)}>
                    {other.kind === 'hypothesis' ? `${other.title}: ${other.summary.slice(0, 60)}` : other.title}
                  </button>
                  {seq !== undefined && (
                    <Link to={`${base}/ledger#${e.evidenceId}`} className="xs">
                      ledger #{seq}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function EvidencePath({ b }: { b: Bundle }) {
  // Derived on each render from the already-fetched bundle; cheap, so no memo or stored copy.
  const model = buildEvidencePath(b);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nodes = model.columns.flatMap((c) => c.nodes);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const related = selected ? new Set(edgesFor(model, selected.id).flatMap((e) => [e.from, e.to])) : null;

  const onKeyDown = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.key === 'Escape') {
      setSelectedId(null);
      return;
    }
    const t = ev.target as HTMLElement;
    if (!t.dataset.col || !['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return;
    const col = Number(t.dataset.col);
    const row = Number(t.dataset.row);
    const find = (c: number, r: number) => ev.currentTarget.querySelector<HTMLElement>(`[data-col="${c}"][data-row="${r}"]`);
    let target: HTMLElement | null = null;
    if (ev.key === 'ArrowDown') target = find(col, row + 1);
    if (ev.key === 'ArrowUp') target = find(col, row - 1);
    for (let c = col + 1; ev.key === 'ArrowRight' && !target && c < 5; c++) target = find(c, Math.min(row, (model.columns[c].nodes.length || 1) - 1));
    for (let c = col - 1; ev.key === 'ArrowLeft' && !target && c >= 0; c--) target = find(c, Math.min(row, (model.columns[c].nodes.length || 1) - 1));
    if (target) {
      ev.preventDefault();
      target.focus();
    }
  };

  return (
    <section className="card epath-card" aria-labelledby="epath-title" onKeyDown={onKeyDown}>
      <div className="card-head">
        <div className="stack-xs">
          <h2 id="epath-title">Evidence path</h2>
          <span className="small muted">What failed → what could explain it → what was tested → what the results showed → which fix was validated</span>
        </div>
        <span className="xs faint">Solid links are recorded relationships; dashed means order only.</span>
      </div>
      <div className="epath-scroll">
        <ol className="epath" aria-label="Evidence path steps">
          {model.columns.map((c, ci) => {
            const conn = ci > 0 ? model.connectors[ci - 1] : null;
            return [
              conn && (
                <li key={`conn-${c.key}`} className={`econn ${conn.recorded ? 'is-recorded' : 'is-order'}`} aria-hidden="true" title={conn.label}>
                  <svg viewBox="0 0 28 12" aria-hidden="true">
                    <line x1="1" y1="6" x2="23" y2="6" />
                    <path d="M20 2 L26 6 L20 10" />
                  </svg>
                </li>
              ),
              <li key={c.key} className="ecol" aria-label={`${c.title}: ${c.nodes.length} ${c.nodes.length === 1 ? 'item' : 'items'}`}>
                <div className="ecol-head">
                  <span>
                    {ci + 1}. {c.title}
                  </span>
                  <span className="count">{c.nodes.length}</span>
                </div>
                {conn && (
                  <div className={`ecol-rel ${conn.recorded ? '' : 'is-order'}`} title={conn.recorded ? 'Recorded relationships from the previous step' : 'No record links these steps; shown in investigation order'}>
                    {conn.recorded ? conn.label : `order only · ${conn.label}`}
                  </div>
                )}
                {c.nodes.length === 0 ? (
                  <p className="ecol-empty">
                    {c.key === 'hypotheses' ? 'Not formed yet.' : c.key === 'experiments' ? 'Not planned yet.' : c.key === 'remediation' ? (b.investigation.remediationType === 'retry' ? 'Retry advised; no code change.' : 'No candidate fix.') : '—'}
                  </p>
                ) : (
                  c.nodes.map((n, ri) => (
                    <NodeButton
                      key={n.id}
                      n={n}
                      col={ci}
                      row={ri}
                      b={b}
                      selected={n.id === selectedId}
                      related={Boolean(related?.has(n.id) && n.id !== selectedId)}
                      dimmed={Boolean(related && !related.has(n.id) && n.id !== selectedId)}
                      onSelect={() => setSelectedId(n.id === selectedId ? null : n.id)}
                    />
                  ))
                )}
              </li>,
            ];
          })}
        </ol>
      </div>
      {selected ? (
        <Details model={model} node={selected} b={b} onSelect={setSelectedId} />
      ) : (
        <p className="epath-hint xs faint">Select a step to see its recorded relationships and open the underlying record. Arrow keys move between steps; Esc clears.</p>
      )}
    </section>
  );
}
