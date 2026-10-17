import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Experiment } from '../api';
import { AttemptStrip, Badge, Callout, CodeBlock, duration, Empty, ErrorBox, EXP_KIND, ExpStatus, Icon, KIND, Loading, pct, Sha, Terminal, TimeAgo } from '../components/ui';
import { useApi } from '../hooks';

function outcomeText(e: Experiment): { big: string; sub: string; tone: string } {
  const r = e.result;
  if (e.backend === 'tavily') return { big: e.status === 'skipped' ? 'Skipped' : 'Search complete', sub: e.observation ?? e.reason, tone: '' };
  if (e.status === 'skipped') return { big: 'Skipped', sub: e.reason, tone: '' };
  if (e.status === 'error') return { big: 'Could not run', sub: 'The sandbox could not execute this experiment.', tone: 'var(--warn)' };
  if (!r || r.attempts.length === 0) return { big: e.status === 'running' ? 'Running…' : 'Queued', sub: `${e.plannedAttempts} planned ${e.plannedAttempts === 1 ? 'run' : 'runs'}`, tone: 'var(--info)' };
  const n = r.attempts.length;
  if (r.failures === 0) return { big: `${n === 1 ? 'Passed' : `All ${n} runs passed`}`, sub: `${n} of ${n} passed`, tone: 'var(--ok)' };
  if (r.failures === n) return { big: `${n === 1 ? 'Failed' : `All ${n} runs failed`}`, sub: 'Failed on every run', tone: 'var(--fail)' };
  return { big: `${r.failures} of ${n} runs failed`, sub: `${r.passes} passed · intermittent`, tone: 'var(--warn)' };
}

/** Formats only the environment the runner actually recorded. */
function Isolation({ env }: { env: Record<string, unknown> }) {
  const rows: Array<[string, string, string]> = [];
  const push = (icon: string, label: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '') rows.push([icon, label, String(value)]);
  };
  push('box', 'Backend', env.backend === 'docker' ? 'Docker container (throwaway)' : env.backend);
  push('file', 'Image', env.image);
  push('globe', 'Network', env.network === 'none' ? 'Disabled during test runs' : env.network);
  push('user', 'User', env.user ? `${env.user} (non-root)` : undefined);
  push('shield', 'Filesystem', env.readOnlyRoot === true ? 'Read-only root · writable workspace and /tmp only' : undefined);
  push('shield', 'Capabilities', env.capabilities === 'all dropped' ? 'All dropped · no-new-privileges' : env.capabilities);
  push('cpu', 'Resources', env.cpus || env.memory ? `${env.cpus ?? '?'} CPU · ${env.memory ?? '?'} memory` : undefined);
  push('clock', 'Timeout', env.timeoutSec ? `${env.timeoutSec} s per run` : undefined);
  push('link', 'Endpoint', env.endpoint);
  push('search', 'Search depth', env.search_depth);
  const installs = Array.isArray(env.dependencyInstall) ? (env.dependencyInstall as Array<{ exitCode: number | null; durationMs: number }>) : [];
  return (
    <div className="stack-sm">
      <dl className="kv">
        {rows.map(([icon, label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt className="row" style={{ gap: 6 }}>
              <Icon name={icon} className="" /> {label}
            </dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {installs.length > 0 && (
        <p className="xs muted">
          Dependency install ran first with networking enabled and no secrets: {installs.map((d, i) => `step ${i + 1} exit ${d.exitCode ?? 'timeout'} (${duration(d.durationMs)})`).join(', ')}.
        </p>
      )}
    </div>
  );
}

export function ExperimentDetail() {
  const { id = '', expId = '' } = useParams();
  const { data, error, loading, reload } = useApi(() => api.investigation(id), [id], (d) => {
    const e = d?.experiments.find((x) => x.id === expId);
    return e && (e.status === 'running' || e.status === 'queued') ? 1500 : null;
  });
  const [picked, setPicked] = useState<number | null>(null);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !data) return <Loading rows={6} label="Loading experiment" />;
  const idx = data?.experiments.findIndex((e) => e.id === expId) ?? -1;
  const exp = idx >= 0 ? data!.experiments[idx] : undefined;
  if (!data || !exp) {
    return (
      <div className="card">
        <Empty title="Experiment not found" icon="flask">
          <Link to={`/investigations/${id}`} className="btn">
            Back to investigation
          </Link>
        </Empty>
      </div>
    );
  }
  const inv = data.investigation;
  const prevExp = data.experiments[idx - 1];
  const nextExp = data.experiments[idx + 1];
  const patch = exp.patchId ? data.patches.find((p) => p.id === exp.patchId) : null;
  const hyp = data.hypotheses.find((h) => h.key === exp.hypothesisKey);
  const r = exp.result;
  const selected = picked ?? r?.attempts.find((a) => !a.passed)?.index ?? r?.attempts[0]?.index ?? null;
  const attempt = r?.attempts.find((a) => a.index === selected);
  const ledger = data.evidence.filter((e) => e.experimentId === exp.id);
  const out = outcomeText(exp);
  const commitRole = exp.commitSha === inv.parentSha ? 'parent commit' : exp.commitSha === inv.commitSha ? (patch ? 'failing commit + candidate patch' : 'failing commit') : '';
  const sources = data.sources.filter((s) => ledger.some((l) => l.sourceId === s.id));

  return (
    <div className="stack-md">
      <div className="page-head" style={{ marginBottom: 4 }}>
        <div style={{ minWidth: 0, flex: '1 1 480px' }}>
          <div className="row-wrap" style={{ marginBottom: 8 }}>
            <Badge tone="tone-outline" icon="flask">
              {EXP_KIND[exp.kind] ?? exp.kind}
            </Badge>
            <ExpStatus exp={exp} withLabel />
            <Badge tone="tone-neutral" icon={exp.backend === 'tavily' ? 'globe' : exp.backend === 'docker' ? 'box' : 'skip'}>
              {exp.backend === 'docker' ? 'Docker sandbox' : exp.backend === 'tavily' ? 'Tavily API' : 'Not executed'}
            </Badge>
          </div>
          <h1>{exp.title}</h1>
          <p className="lead">{exp.reason}</p>
        </div>
        <div className="page-actions">
          <Link to={`/investigations/${id}`} className="btn">
            <Icon name="chevronLeft" /> Investigation
          </Link>
          <Link to={prevExp ? `/investigations/${id}/experiments/${prevExp.id}` : '#'} className="btn btn-icon" aria-disabled={!prevExp} aria-label="Previous experiment" title={prevExp?.title} style={prevExp ? undefined : { pointerEvents: 'none', opacity: 0.45 }}>
            <Icon name="chevronLeft" />
          </Link>
          <Link to={nextExp ? `/investigations/${id}/experiments/${nextExp.id}` : '#'} className="btn btn-icon" aria-disabled={!nextExp} aria-label="Next experiment" title={nextExp?.title} style={nextExp ? undefined : { pointerEvents: 'none', opacity: 0.45 }}>
            <Icon name="chevron" />
          </Link>
        </div>
      </div>

      <section className="card" aria-label="Experiment summary">
        <div className="grid cols-4" style={{ gap: 0 }}>
          <div className="metric" style={{ borderRight: '1px solid var(--divider)' }}>
            <div className="label">Outcome</div>
            <div className="value" style={{ fontSize: 20, color: out.tone || undefined }}>
              {out.big}
            </div>
            <div className="hint">{out.sub}</div>
          </div>
          <div className="metric" style={{ borderRight: '1px solid var(--divider)' }}>
            <div className="label">Observed failure rate</div>
            <div className="value" style={{ fontSize: 20 }}>
              {r?.failureRate ? pct(r.failureRate.rate) : r && r.attempts.length ? pct(r.failures / r.attempts.length) : '—'}
            </div>
            <div className="hint">{r?.failureRate ? `95% CI ${pct(r.failureRate.low)}–${pct(r.failureRate.high)} · n=${r.failureRate.n}` : r && r.attempts.length === 1 ? 'Single run: no rate estimate' : 'No runs'}</div>
          </div>
          <div className="metric" style={{ borderRight: '1px solid var(--divider)' }}>
            <div className="label">Commit</div>
            <div className="value" style={{ fontSize: 16, marginTop: 8 }}>
              <Sha sha={exp.commitSha} n={12} />
            </div>
            <div className="hint">{commitRole || '—'}</div>
          </div>
          <div className="metric">
            <div className="label">Duration</div>
            <div className="value" style={{ fontSize: 20 }}>
              {duration(exp.durationMs)}
            </div>
            <div className="hint">{exp.startedAt ? <>started <TimeAgo iso={exp.startedAt} /></> : 'Not started'}</div>
          </div>
        </div>
        {exp.backend === 'docker' && exp.plannedAttempts > 0 && (
          <div className="card-foot stack-sm" style={{ background: 'var(--surface)' }}>
            <span className="xs faint">Each square is one run in a fresh container. Select a run to inspect its output.</span>
            <AttemptStrip exp={exp} large selected={selected} onSelect={setPicked} />
          </div>
        )}
      </section>

      {exp.effect && exp.status !== 'skipped' && (
        <Callout icon="target" tone={/Supports|validated|passes/.test(exp.effect) ? 'tone-pass' : /Contradicts|does not fix|breaks/.test(exp.effect) ? 'tone-fail' : ''}>
          <strong>Effect on the diagnosis</strong>
          <span style={{ whiteSpace: 'pre-wrap' }}>{exp.effect}</span>
        </Callout>
      )}

      <div className="split">
        <div className="stack-md" style={{ minWidth: 0 }}>
          {r && r.attempts.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>Runs</h2>
                <span className="small muted">
                  {r.passes} passed · {r.failures} failed
                </span>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Outcome</th>
                      <th className="num">Exit</th>
                      <th>Seed</th>
                      <th>Tests</th>
                      <th className="num">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.attempts.map((a) => (
                      <tr key={a.index} className={`clickable ${selected === a.index ? 'selected' : ''}`} onClick={() => setPicked(a.index)}>
                        <td>
                          <button className="btn btn-ghost btn-sm" onClick={() => setPicked(a.index)} aria-pressed={selected === a.index} aria-label={`Show output of run ${a.index}`} style={{ padding: '0 6px' }}>
                            #{a.index}
                          </button>
                        </td>
                        <td>
                          <Badge tone={a.passed ? 'tone-pass' : 'tone-fail'} icon={a.passed ? 'ok' : 'fail'}>
                            {a.timedOut ? 'Timed out' : a.passed ? 'Passed' : 'Failed'}
                          </Badge>
                        </td>
                        <td className="num mono">{a.exitCode ?? '—'}</td>
                        <td className="mono">{a.seed ?? '—'}</td>
                        <td>
                          {a.tests ? `${a.tests.passed}/${a.tests.total} passed` : <span className="muted">Build failed before tests</span>}
                          {a.tests?.failedNames.length ? <div className="cell-sub truncate" style={{ maxWidth: 220 }} title={a.tests.failedNames.join('; ')}>{a.tests.failedNames.join('; ')}</div> : null}
                        </td>
                        <td className="num">{duration(a.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {attempt && (
            <Terminal
              text={attempt.outputTail || '(no output)'}
              title={`Run #${attempt.index}`}
              meta={
                <span>
                  exit {attempt.exitCode ?? '—'}
                  {attempt.seed !== undefined ? ` · seed ${attempt.seed}` : ''} · {duration(attempt.durationMs)} · last 6 KB, redacted
                </span>
              }
            />
          )}
          {exp.backend === 'tavily' && sources.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>Results</h2>
                <Link to={`/investigations/${id}/sources`} className="small">
                  All sources
                </Link>
              </div>
              <ul className="exp-list">
                {sources.map((s) => (
                  <li key={s.id} className="exp-item" style={{ gridTemplateColumns: '22px minmax(0,1fr)' }}>
                    <Icon name={s.official ? 'shield' : 'globe'} />
                    <div>
                      <a href={s.url} target="_blank" rel="noreferrer" className="title">
                        {s.title}
                      </a>
                      <p className="obs">{s.excerpt.slice(0, 220)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!r?.attempts.length && exp.backend !== 'tavily' && (
            <div className="card">
              <Empty title={exp.status === 'skipped' ? 'Not executed' : exp.status === 'error' ? 'Could not run' : 'No runs yet'} icon={exp.status === 'skipped' ? 'skip' : 'flask'}>
                <p>{exp.observation ?? exp.reason}</p>
              </Empty>
            </div>
          )}
        </div>

        <aside className="stack-md" style={{ minWidth: 0 }}>
          <div className="card card-body stack-sm">
            <h3>Setup</h3>
            <dl className="kv">
              <dt>Investigation</dt>
              <dd>
                <Link to={`/investigations/${id}`}>{inv.repository}</Link>
              </dd>
              <dt>Selection</dt>
              <dd className="mono">{exp.testSelection ?? '—'}</dd>
              <dt>Tests</dt>
              <dd>{hyp ? <Link to={`/investigations/${id}/ledger?hyp=${hyp.key}`}>{hyp.key}</Link> : '—'}{hyp ? ` · ${hyp.cause}` : ''}</dd>
              {patch && (
                <>
                  <dt>Candidate</dt>
                  <dd>{patch.title}</dd>
                </>
              )}
            </dl>
            {exp.command?.length ? (
              <div className="stack-xs">
                <span className="eyebrow">{exp.backend === 'tavily' ? 'Queries' : 'Command (last run)'}</span>
                <CodeBlock text={exp.backend === 'tavily' ? exp.command.join('\n') : exp.command.join(' ')} />
              </div>
            ) : null}
          </div>
          <div className="card card-body stack-sm">
            <h3 className="row" style={{ gap: 8 }}>
              <Icon name="shield" /> Isolation
            </h3>
            {exp.environment ? <Isolation env={exp.environment} /> : <p className="small muted">{exp.status === 'skipped' ? 'Not executed, so no environment was recorded.' : 'Recorded when the experiment finishes.'}</p>}
          </div>
          {ledger.length > 0 && (
            <div className="card card-body stack-sm">
              <h3>Ledger records</h3>
              <ul className="stack-xs" style={{ listStyle: 'none', padding: 0 }}>
                {ledger.map((e) => (
                  <li key={e.id} className="row small row-top" style={{ gap: 8 }}>
                    <span className="mono faint">#{e.seq}</span>
                    <span className={`k-${e.kind}`} title={KIND[e.kind].label}>
                      <Icon name={KIND[e.kind].icon} className="" />
                    </span>
                    <Link to={`/investigations/${id}/ledger#${e.id}`} className="wrap-any">
                      {e.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
