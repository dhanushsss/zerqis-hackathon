import { Link } from 'react-router-dom';
import type { Bundle, Hypothesis } from '../../api';
import { Badge, CLASS_LABEL, EXP_KIND, HypStatusBadge, Icon, useChangeFlash } from '../../components/ui';
import { effectsFor } from './derive';

/** Why the hypothesis stands where it does, in one sentence derived only from recorded effects. */
function outcomeLine(status: string, s: number, c: number, contradictedBy: string[]): string {
  if (status === 'supported') return c ? `Survived: ${s} supporting result${s === 1 ? '' : 's'}, ${c} contradicting.` : `Survived: ${s} supporting result${s === 1 ? '' : 's'} and none against it.`;
  if (status === 'refuted') return contradictedBy.length ? `Rejected: contradicted by ${contradictedBy.join(', ')}.` : 'Rejected in the final assessment; no experiment contradicted it directly.';
  if (s + c === 0) return 'Unresolved: no experiment has tested it yet.';
  return `Unresolved: ${s} supporting, ${c} contradicting; the evidence does not decide it.`;
}

function HypothesisCard({ h, b }: { h: Hypothesis; b: Bundle }) {
  const base = `/investigations/${b.investigation.id}`;
  const effects = effectsFor(b, h.key);
  const s = effects.filter((e) => e.effect === 'supports');
  const c = effects.filter((e) => e.effect === 'contradicts');
  const primary = b.investigation.primaryHypothesis === h.key && b.investigation.verdict;
  const exps = [...new Set(effects.map((e) => e.experimentId))].map((id) => b.experiments.find((x) => x.id === id)).filter(Boolean);
  const unverified = h.supporting.filter((q) => !q.verified).length;
  const statusChanged = useChangeFlash(h.status);

  return (
    <article id={`hyp-card-${h.key}`} tabIndex={-1} className={`card hyp ${h.status} ${primary ? 'primary' : ''} ${statusChanged ? 'changed' : ''}`} aria-labelledby={`hyp-${h.key}`}>
      <div className="row-wrap">
        <Badge tone="tone-model" className="square">
          {h.key}
        </Badge>
        <span className="small muted">{CLASS_LABEL[h.category]}</span>
        {primary && (
          <Badge tone="tone-outline" icon="target">
            Primary
          </Badge>
        )}
        <span className="spacer" />
        <HypStatusBadge status={h.status} />
      </div>
      <p className="cause" id={`hyp-${h.key}`}>
        {h.cause}
      </p>
      <p className={`hyp-outcome ${h.status}`}>
        {outcomeLine(
          h.status,
          s.length,
          c.length,
          [...new Set(c.map((e) => b.experiments.find((x) => x.id === e.experimentId)).filter((x) => x).map((x) => EXP_KIND[x!.kind] ?? x!.kind))],
        )}
      </p>
      <div className="tally" aria-label={`${s.length} supporting and ${c.length} contradicting experiment results`}>
        <span className="s">
          <Icon name="ok" /> {s.length} supporting
        </span>
        <span className="c">
          <Icon name="fail" /> {c.length} contradicting
        </span>
        <span className="faint">prior {h.prior}</span>
      </div>
      {effects.length > 0 && (
        <ul className="effects">
          {effects.map((e) => {
            const exp = b.experiments.find((x) => x.id === e.experimentId);
            return (
              <li key={e.id} className={e.effect === 'supports' ? 's' : 'c'}>
                <Icon name={e.effect === 'supports' ? 'ok' : 'fail'} label={e.effect === 'supports' ? 'Supports' : 'Contradicts'} />
                <span>
                  {exp && (
                    <Link to={`${base}/experiments/${exp.id}`} className="strong">
                      {EXP_KIND[exp.kind]}
                    </Link>
                  )}
                  {exp ? ' — ' : ''}
                  <Link to={`${base}/ledger#${e.id}`} className="ledger-ref" title={`Open ledger record #${e.seq}`}>
                    {e.detail}
                  </Link>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {effects.length === 0 && <p className="small faint">No experiment has tested this hypothesis directly yet.</p>}
      {h.supporting.length > 0 && (
        <details className="disclosure">
          <summary>
            <Icon name="chevron" /> Evidence cited when proposed ({h.supporting.length}
            {unverified ? `, ${unverified} unverified` : ''})
          </summary>
          <div className="disclosure-body">
            {h.supporting.map((q, i) => (
              <span key={i} className={`quote ${q.verified ? '' : 'unverified'}`} title={q.verified ? 'Found in the CI log or diff' : 'Not found verbatim in the log or diff'}>
                {q.logLine ? <Link to={`${base}/log?line=${q.logLine}`}>L{q.logLine}</Link> : null} {q.text}
                {!q.verified && <em className="faint"> · not found in log</em>}
              </span>
            ))}
          </div>
        </details>
      )}
      <div className="hyp-links">
        <Link to={`${base}/ledger?hyp=${h.key}`}>
          Ledger records for {h.key} <Icon name="arrowRight" className="" />
        </Link>
        {exps.length > 0 && <span className="faint">{exps.length} experiment{exps.length === 1 ? '' : 's'}</span>}
        <span className="faint">{h.origin === 'model' ? 'Model-generated' : h.origin === 'replay' ? 'Model output (replay)' : 'Heuristic rules'}</span>
      </div>
    </article>
  );
}

export function Hypotheses({ b }: { b: Bundle }) {
  const order = { supported: 0, inconclusive: 1, open: 2, refuted: 3 } as Record<string, number>;
  const sorted = [...b.hypotheses].sort((x, y) => {
    const p = b.investigation.primaryHypothesis;
    if (x.key === p) return -1;
    if (y.key === p) return 1;
    return (order[x.status] ?? 9) - (order[y.status] ?? 9) || x.rank - y.rank;
  });
  return (
    <div className={`hyps n${Math.min(sorted.length, 3)}`}>
      {sorted.map((h) => (
        <HypothesisCard key={h.id} h={h} b={b} />
      ))}
    </div>
  );
}
