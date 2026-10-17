import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Bundle } from '../../api';
import { Badge, Callout, duration, Empty, ErrorBox, ExpStatus, Icon, Loading, MODE_INFO, stripAnsi, TimeAgo } from '../../components/ui';
import { useApi } from '../../hooks';

export function Sources({ b }: { b: Bundle }) {
  const search = b.experiments.find((e) => e.kind === 'external_search');
  return (
    <div className="stack-md">
      <Callout icon="globe">
        <span>
          Retrieved during the investigation with the Tavily Search API. Queries are built from extracted package names, versions, and error symbols. Search results are <strong>leads, not proof</strong>. Only official domains and the implicated project's repository count as primary sources.
        </span>
      </Callout>
      {search && (
        <div className="card card-body stack-sm">
          <div className="row-wrap">
            <ExpStatus exp={search} withLabel />
            <span className="small muted">{search.observation ?? search.reason}</span>
          </div>
          {search.command && (
            <div className="stack-xs">
              {search.command.map((c, i) => (
                <code key={i} className="small">
                  {c}
                </code>
              ))}
            </div>
          )}
        </div>
      )}
      {b.sources.length === 0 ? (
        <div className="card">
          <Empty title="No external sources" icon="globe">
            <p>
              {search
                ? search.status === 'skipped'
                  ? 'Tavily is not configured (TAVILY_API_KEY). The rest of the investigation is unaffected.'
                  : 'The searches returned no results.'
                : 'No hypothesis implicated an external dependency or service, so no search was run.'}
            </p>
            {search?.status === 'skipped' && (
              <Link to="/integrations" className="btn btn-sm">
                Set up Tavily
              </Link>
            )}
          </Empty>
        </div>
      ) : (
        <div className="grid cols-2">
          {b.sources.map((s) => (
            <article key={s.id} className="card card-body stack-sm">
              <div className="row-wrap">
                <Badge tone={s.official ? 'tone-pass' : 'tone-web'} icon={s.official ? 'shield' : 'globe'}>
                  {s.official ? 'Primary source' : 'Secondary source'}
                </Badge>
                <span className="xs faint truncate">{s.domain}</span>
                {s.score !== null && <span className="xs faint">relevance {s.score.toFixed(2)}</span>}
              </div>
              <a href={s.url} target="_blank" rel="noreferrer" className="strong">
                {s.title} <Icon name="external" className="" />
              </a>
              <p className="small muted">{s.excerpt}</p>
              <p className="xs faint">
                Query “{s.query}” · retrieved <TimeAgo iso={s.retrievedAt} />
                {s.publishedDate ? ` · published ${s.publishedDate}` : ''}
              </p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function LogTab({ id }: { id: string }) {
  const [params] = useSearchParams();
  const line = Number(params.get('line')) || 0;
  const to = Number(params.get('to')) || line;
  const from = line ? Math.max(1, line - 200) : 1;
  const { data, error, loading, reload } = useApi(() => api.log(id, from, from + 1999), [id, from]);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (data && line) ref.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
  }, [data, line]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !data) return <Loading rows={8} label="Loading CI log" />;
  return (
    <div className="stack-sm">
      <div className="row-wrap small muted">
        <span>
          Lines {data.from.toLocaleString()}–{data.to.toLocaleString()} of {data.totalLines.toLocaleString()}
        </span>
        <span>·</span>
        <span>Secrets were redacted before storage</span>
        {line > 0 && (
          <>
            <span>·</span>
            <span>
              Highlighting L{line}
              {to > line ? `–${to}` : ''}
            </span>
          </>
        )}
      </div>
      <div className="logview" ref={ref} tabIndex={0} aria-label="CI log">
        {data.lines.map((l, i) => {
          const n = data.from + i;
          const text = stripAnsi(l);
          const hl = line && n >= line && n <= Math.max(to, line);
          const err = /##\[error\]|\[ERROR\]|●|FAIL |AssertionError/.test(text);
          return (
            <div key={n} data-line={n} className={`l ${hl ? 'hl' : ''} ${err ? 'err' : ''}`}>
              <span className="n">
                <Link to={`?line=${n}`} aria-label={`Link to line ${n}`}>
                  {n}
                </Link>
              </span>
              <span className="t">{text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ModelCalls({ b }: { b: Bundle }) {
  const mode = MODE_INFO[b.investigation.mode];
  return (
    <div className="stack-md">
      <Callout icon={mode?.icon ?? 'info'} tone={b.investigation.mode === 'live' ? 'tone-info' : ''}>
        <span>
          <strong>{mode?.label}.</strong> {mode?.help} Model output is validated against a JSON schema before use, and cited log quotes are machine-checked.
        </span>
      </Callout>
      <div className="card">
        {b.modelCalls.length === 0 ? (
          <Empty title="No model calls" icon="bulb">
            <p>This investigation used deterministic heuristics for the model stages.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th className="num">Latency</th>
                  <th className="num">Tokens in / out</th>
                  <th className="num">Input</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {b.modelCalls.map((c) => (
                  <tr key={c.id}>
                    <td>{c.step}</td>
                    <td className="mono">{c.model}</td>
                    <td>
                      <Badge tone={c.status === 'ok' ? 'tone-pass' : c.status === 'replay' ? 'tone-warn' : 'tone-fail'} icon={c.status === 'ok' ? 'ok' : c.status === 'replay' ? 'refresh' : 'fail'}>
                        {c.status}
                      </Badge>
                    </td>
                    <td className="num">{c.status === 'replay' ? '—' : duration(c.durationMs)}</td>
                    <td className="num mono">
                      {c.promptTokens ?? '—'} / {c.completionTokens ?? '—'}
                    </td>
                    <td className="num">{(c.inputChars / 1024).toFixed(1)} KB</td>
                    <td className="muted">{c.error ?? (c.attempts > 1 ? `${c.attempts} attempts` : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {Object.keys(b.investigation.modelsUsed).length > 0 && (
        <div className="card card-body">
          <h3 style={{ marginBottom: 10 }}>Models used per stage</h3>
          <dl className="kv">
            {Object.entries(b.investigation.modelsUsed).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd className="mono">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
