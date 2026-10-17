import { Link } from 'react-router-dom';
import type { Bundle } from '../../api';
import { AttemptStrip, Badge, CLASS_LABEL, ConfidenceBadge, EXP_KIND, Icon, VerdictBadge } from '../../components/ui';
import { AgentOutcome } from './AgentOutcome';
import { counterEvidence, observationsBetween, strongestSupport } from './derive';

export function Verdict({ b }: { b: Bundle }) {
  const inv = b.investigation;
  const base = `/investigations/${inv.id}`;
  const primary = b.hypotheses.find((h) => h.key === inv.primaryHypothesis);
  const support = strongestSupport(b);
  const counter = counterEvidence(b);
  const running = inv.status === 'running' || inv.status === 'queued';

  if (!inv.verdict) {
    return (
      <section id="verdict-card" tabIndex={-1} className="card card-body" aria-labelledby="verdict-title">
        <div className="row-wrap">
          <h2 id="verdict-title">Verdict</h2>
          <span className="spacer" />
          <Badge tone={inv.status === 'failed' ? 'tone-fail' : 'tone-neutral'} icon={inv.status === 'failed' ? 'fail' : running ? 'loader' : 'pending'}>
            {inv.status === 'failed' ? 'Not reached' : 'Awaiting experiments'}
          </Badge>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          Alibi issues no verdict until experiments have run. Until then, the hypotheses below are unproven claims.
        </p>
      </section>
    );
  }

  return (
    <section id="verdict-card" tabIndex={-1} className="card verdict" aria-labelledby="verdict-title">
      <div className="verdict-main">
        <div className="stack-sm">
          <span className="eyebrow" id="verdict-title">
            Verdict
          </span>
          <div className="verdict-line">
            <VerdictBadge verdict={inv.verdict} lg />
            <span className="cls">{CLASS_LABEL[inv.classification ?? 'unknown']}</span>
            <ConfidenceBadge label={inv.confidence?.label} />
          </div>
          {primary && (
            <p style={{ fontWeight: 500 }}>
              <Link to={`${base}/ledger?hyp=${primary.key}`} className="badge tone-model square" style={{ marginRight: 8, verticalAlign: 1 }}>
                {primary.key}
              </Link>
              {primary.cause}
            </p>
          )}
          {inv.summary && primary && inv.summary.includes(primary.cause) ? null : <p className="verdict-summary small">{inv.summary}</p>}
        </div>

        <div className="facts">
          <div className="fact tone-pass">
            <span className="fact-label">
              <Icon name="ok" /> Strongest support
            </span>
            {support ? (
              <div className="fact-body stack-xs">
                <Link to={`${base}/experiments/${support.exp.id}`} className="row" style={{ gap: 8 }}>
                  <strong>{EXP_KIND[support.exp.kind]}</strong>
                  {support.exp.backend === 'docker' && <AttemptStrip exp={support.exp} />}
                </Link>
                <span className="muted">{support.why}</span>
              </div>
            ) : (
              <span className="fact-body muted">No experiment directly supports the primary hypothesis.</span>
            )}
          </div>
          <div className={`fact ${counter.against.length ? 'tone-fail' : ''}`}>
            <span className="fact-label">
              <Icon name="fail" /> Counter-evidence
            </span>
            <div className="fact-body stack-xs">
              {counter.against.length ? (
                counter.against.map((c, i) => (
                  <span key={i}>
                    {c.exp && <Link to={`${base}/experiments/${c.exp.id}`}>{EXP_KIND[c.exp.kind]}: </Link>}
                    {c.why}
                  </span>
                ))
              ) : (
                <span className="muted">No experiment contradicted {primary?.key ?? 'the primary hypothesis'}.</span>
              )}
              {counter.ruledOut.length > 0 && (
                <span className="muted">
                  Ruled out:{' '}
                  {counter.ruledOut.map((h, i) => (
                    <span key={h.key}>
                      {i > 0 && ', '}
                      <Link to={`${base}/ledger?hyp=${h.key}`}>
                        {h.key} {CLASS_LABEL[h.category].toLowerCase()}
                      </Link>
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>
          <div className="fact">
            <span className="fact-label">
              <Icon name="target" /> Why {inv.confidence?.label ?? 'this'} confidence
            </span>
            <ul className="basis">
              {(inv.confidence?.basis ?? []).map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
          <div className="fact">
            <span className="fact-label">
              <Icon name="arrowRight" /> Next action
            </span>
            <p className="fact-body">{inv.recommendedAction ?? 'Review the evidence ledger.'}</p>
            {b.patches.some((p) => p.status === 'validated') && (
              <a href="#remediation" className="small">
                Review the validated fix
              </a>
            )}
          </div>
        </div>
        <AgentOutcome agent={inv.agent} />
        {inv.limitations.length > 0 && (
          <details className="disclosure">
            <summary>
              <Icon name="chevron" /> {inv.limitations.length} {inv.limitations.length === 1 ? 'limitation' : 'limitations'} of this diagnosis
            </summary>
            <ul className="basis disclosure-body">
              {inv.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <aside className="verdict-side" aria-labelledby="evolution-title">
        <h3 id="evolution-title" style={{ marginBottom: 4 }}>
          How the verdict evolved
        </h3>
        <p className="xs faint" style={{ marginBottom: 14 }}>
          Each step lists the observations that justified it.
        </p>
        <ol className="timeline">
          {inv.verdictHistory.map((v, i) => {
            const obs = observationsBetween(b, i === 0 ? null : inv.verdictHistory[i - 1].at, v.at);
            const tone = v.verdict === 'confirmed' ? 'tone-pass' : v.verdict === 'probable' ? 'tone-info' : v.verdict ? 'tone-warn' : '';
            return (
              <li className="tl-item" key={i}>
                <span className={`tl-dot ${tone}`}>
                  <Icon name={v.verdict === 'confirmed' ? 'check' : v.verdict === 'probable' ? 'target' : v.verdict ? 'unsure' : 'bulb'} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="row-wrap" style={{ gap: 8 }}>
                    <strong className="small">{v.stage}</strong>
                    {v.verdict ? <VerdictBadge verdict={v.verdict} /> : <span className="xs faint">no verdict yet</span>}
                  </div>
                  <p className="small muted" style={{ marginTop: 4 }}>
                    {v.note}
                  </p>
                  {obs.length > 0 && (
                    <div className="tl-obs">
                      {obs.map((e) => (
                        <Link key={e.id} to={`${base}/experiments/${e.id}`}>
                          {e.backend === 'docker' ? <AttemptStrip exp={e} /> : <Icon name="globe" />}
                          <span className="truncate">{e.title}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </aside>
    </section>
  );
}
