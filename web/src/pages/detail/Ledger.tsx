import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { Bundle, EvidenceRecord } from '../../api';
import { Badge, clock, CodeBlock, Empty, Icon, KIND } from '../../components/ui';
import { phaseOf, PHASE_LABEL, type Phase } from './derive';

function Provenance({ e, b, onHyp }: { e: EvidenceRecord; b: Bundle; onHyp: (k: string) => void }) {
  const inv = b.investigation;
  const base = `/investigations/${inv.id}`;
  const p = e.provenance;
  const exp = e.experimentId ? b.experiments.find((x) => x.id === e.experimentId) : null;
  const ref = p.ref;
  const range = ref && /^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/.test(ref) ? ref : null;
  return (
    <div className="prov">
      {p.lines && (
        <span>
          <Icon name="file" />
          <Link to={`${base}/log?line=${p.lines[0]}&to=${p.lines[1]}`}>
            CI log L{p.lines[0]}
            {p.lines[1] !== p.lines[0] ? `–${p.lines[1]}` : ''}
          </Link>
        </span>
      )}
      {exp && (
        <span style={{ maxWidth: '100%' }}>
          <Icon name="flask" />
          <Link to={`${base}/experiments/${exp.id}`}>{exp.title}</Link>
        </span>
      )}
      {p.url && (
        <span style={{ maxWidth: '100%' }}>
          <Icon name="globe" />
          <a href={p.url} target="_blank" rel="noreferrer" title={p.url}>
            {(() => {
              try {
                const u = new URL(p.url);
                return `${u.hostname}${u.pathname.length > 1 ? u.pathname : ''}`;
              } catch {
                return p.url;
              }
            })()}
          </a>
        </span>
      )}
      {p.type === 'model' && ref && (
        <span>
          <Icon name="bulb" /> <span className="mono">{ref}</span>
        </span>
      )}
      {(p.type === 'git' || p.type === 'github_api') && ref && (
        <span>
          <Icon name="commit" />
          {range && inv.repoUrl ? (
            <a href={`${inv.repoUrl}/compare/${range.replace('..', '...')}`} target="_blank" rel="noreferrer" className="mono">
              {ref}
            </a>
          ) : (
            <span className="mono">{ref}</span>
          )}
        </span>
      )}
      {(p.type === 'policy' || p.type === 'fixture') && ref && (
        <span>
          <Icon name={p.type === 'policy' ? 'shield' : 'file'} /> <span className="mono">{ref}</span>
        </span>
      )}
      {e.hypothesisKey && (
        <span>
          <Icon name="bulb" />
          <button className="e-more" style={{ marginTop: 0 }} onClick={() => onHyp(e.hypothesisKey!)} title={`Show only records about ${e.hypothesisKey}`}>
            {e.hypothesisKey}
          </button>
        </span>
      )}
      <span>
        <Icon name="clock" />
        <time dateTime={e.createdAt} title={new Date(e.createdAt).toLocaleString()}>
          {clock(e.createdAt)}
        </time>
      </span>
      <span className="faint">source: {p.type.replace('_', ' ')}</span>
    </div>
  );
}

function Entry({ e, b, highlighted, onHyp }: { e: EvidenceRecord; b: Bundle; highlighted: boolean; onHyp: (k: string) => void }) {
  const k = KIND[e.kind];
  const [open, setOpen] = useState(false);
  const cmdIdx = e.detail.indexOf('\nCommand: ');
  const text = cmdIdx >= 0 ? e.detail.slice(0, cmdIdx) : e.detail;
  const command = cmdIdx >= 0 ? e.detail.slice(cmdIdx + 10) : null;
  const long = text.length > 320 || text.split('\n').length > 4;
  return (
    <li className={`entry ${highlighted ? 'hl' : ''}`} id={e.id}>
      <span className="seq">#{e.seq}</span>
      <span className={`kind-ico k-${e.kind}`} title={k.help}>
        <Icon name={k.icon} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="e-kind">
          <span className={`k-${e.kind}`}>{k.label}</span>
          {e.effect && e.effect !== 'neutral' && (
            <Badge tone={e.effect === 'supports' ? 'tone-pass' : 'tone-fail'} icon={e.effect === 'supports' ? 'ok' : 'fail'}>
              {e.effect === 'supports' ? 'Supports' : 'Contradicts'} {e.hypothesisKey}
            </Badge>
          )}
        </div>
        <div className="e-title">{e.title}</div>
        {text && <div className={`e-detail ${long && !open ? 'clamped' : ''}`}>{text}</div>}
        {(long || command) && (
          <button className="e-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Show less' : command && !long ? 'Show command' : 'Show more'}
          </button>
        )}
        {open && command && (
          <div style={{ marginTop: 8 }}>
            <CodeBlock text={command} />
          </div>
        )}
        <Provenance e={e} b={b} onHyp={onHyp} />
      </div>
    </li>
  );
}

export function Ledger({ b }: { b: Bundle }) {
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const kind = params.get('kind') ?? '';
  const hyp = params.get('hyp') ?? '';
  const q = params.get('q') ?? '';
  const [qInput, setQInput] = useState(q);
  const highlightId = hash.slice(1);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const t = setTimeout(() => qInput !== q && set('q', qInput), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);
  // Destination highlight: a record linked by #id (scrolled into view once), or the
  // hypothesis record itself when arriving with ?hyp= (no scrolling).
  const flashId = useMemo(
    () => highlightId || (hyp ? b.evidence.find((e) => e.kind === 'model_hypothesis' && e.hypothesisKey === hyp)?.id ?? '' : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [highlightId, hyp],
  );
  useEffect(() => {
    if (highlightId) document.getElementById(highlightId)?.scrollIntoView({ block: 'center' });
  }, [highlightId]);

  const items = useMemo(() => {
    const needle = q.toLowerCase();
    return b.evidence.filter((e) => (!kind || e.kind === kind) && (!hyp || e.hypothesisKey === hyp) && (!needle || `${e.title} ${e.detail}`.toLowerCase().includes(needle)));
  }, [b.evidence, kind, hyp, q]);

  const groups = useMemo(() => {
    const out: Array<{ phase: Phase; items: EvidenceRecord[] }> = [];
    for (const e of items) {
      const ph = phaseOf(e, b);
      const last = out[out.length - 1];
      if (last && last.phase === ph) last.items.push(e);
      else out.push({ phase: ph, items: [e] });
    }
    return out;
  }, [items, b]);

  const filtered = Boolean(kind || hyp || q);
  const counts = (k: string) => b.evidence.filter((e) => e.kind === k && (!hyp || e.hypothesisKey === hyp)).length;

  return (
    <div className="stack-md">
      <p className="small muted" style={{ maxWidth: '86ch' }}>
        An append-only audit trail of the investigation. Only <strong>experiment results</strong> come from executing code. <strong>Observed facts</strong> are read from the log, git, or APIs. <strong>Hypotheses</strong> and <strong>inferences</strong> are claims, and <strong>assumptions</strong> are not verified.
      </p>
      <div className="ledger-toolbar">
        <div className="chips" role="group" aria-label="Filter by evidence type">
          {Object.entries(KIND).map(([k, v]) => (
            <button key={k} className="chip" aria-pressed={kind === k} onClick={() => set('kind', kind === k ? '' : k)} title={v.help}>
              <Icon name={v.icon} />
              {v.label}
              <span className="n">{counts(k)}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <select className="select" value={hyp} onChange={(e) => set('hyp', e.target.value)} aria-label="Filter by hypothesis">
          <option value="">All hypotheses</option>
          {b.hypotheses.map((h) => (
            <option key={h.key} value={h.key}>
              {h.key} · {h.cause.length > 48 ? `${h.cause.slice(0, 48)}…` : h.cause}
            </option>
          ))}
        </select>
        <div className="input-icon" style={{ width: 220 }}>
          <Icon name="search" />
          <input className="input" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search records" aria-label="Search ledger records" />
        </div>
        {filtered && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setQInput('');
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            <Icon name="x" /> Clear
          </button>
        )}
      </div>
      <div className="card">
        {items.length === 0 ? (
          <Empty title={b.evidence.length ? 'No records match these filters' : 'No records yet'} icon="list" />
        ) : (
          groups.map((g, gi) => (
            <section key={gi} className="phase" aria-label={PHASE_LABEL[g.phase]}>
              <div className="phase-head">
                <span className="eyebrow">{PHASE_LABEL[g.phase]}</span>
                <span className="count">
                  {g.items.length} {g.items.length === 1 ? 'record' : 'records'}
                </span>
              </div>
              <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {g.items.map((e) => (
                  <Entry key={e.id} e={e} b={b} highlighted={e.id === flashId} onHyp={(k) => set('hyp', k)} />
                ))}
              </ol>
            </section>
          ))
        )}
      </div>
      {filtered && (
        <p className="xs faint" aria-live="polite">
          Showing {items.length} of {b.evidence.length} records.
        </p>
      )}
    </div>
  );
}
