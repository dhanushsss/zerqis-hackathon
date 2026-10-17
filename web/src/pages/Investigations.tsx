import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { CLASS_LABEL, Empty, ErrorBox, Icon, Loading } from '../components/ui';
import { useApi } from '../hooks';
import { RecentTable } from './Overview';

const FILTERS = ['status', 'classification', 'verdict', 'source'] as const;

export function Investigations() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const current = Object.fromEntries([...FILTERS, 'q'].map((k) => [k, params.get(k) ?? '']));
  const { data, error, loading, reload } = useApi(
    () => api.investigations(current),
    [params.toString()],
    (d) => (d?.some((i) => i.status === 'running' || i.status === 'queued') ? 3000 : null),
  );

  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get('q') ?? '') !== q) {
        const next = new URLSearchParams(params);
        if (q) next.set('q', q);
        else next.delete('q');
        setParams(next, { replace: true });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, params, setParams]);

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };
  const active = FILTERS.some((k) => params.get(k)) || Boolean(params.get('q'));

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Investigations</h1>
          <p className="lead">Every failed build Alibi has investigated, with its verdict and how it was reached.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head" role="search" style={{ gap: 10 }}>
          <div className="input-icon" style={{ flex: '1 1 260px' }}>
            <Icon name="search" />
            <input className="input" placeholder="Search repository, commit, signature…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search investigations" />
          </div>
          <div className="row-wrap">
            <select className="select" value={current.status} onChange={(e) => setFilter('status', e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              {['queued', 'running', 'completed', 'inconclusive', 'failed'].map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <select className="select" value={current.classification} onChange={(e) => setFilter('classification', e.target.value)} aria-label="Filter by classification">
              <option value="">All classifications</option>
              {Object.entries(CLASS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select className="select" value={current.verdict} onChange={(e) => setFilter('verdict', e.target.value)} aria-label="Filter by verdict">
              <option value="">All verdicts</option>
              <option value="confirmed">Confirmed</option>
              <option value="probable">Probable</option>
              <option value="inconclusive">Inconclusive</option>
            </select>
            <select className="select" value={current.source} onChange={(e) => setFilter('source', e.target.value)} aria-label="Filter by source">
              <option value="">All sources</option>
              <option value="github">GitHub</option>
              <option value="demo">Demo fixtures</option>
            </select>
            {active && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setQ('');
                  setParams(new URLSearchParams());
                }}
              >
                <Icon name="x" /> Clear
              </button>
            )}
          </div>
        </div>
        {error && (
          <div className="card-body">
            <ErrorBox error={error} onRetry={reload} />
          </div>
        )}
        {loading && !data ? (
          <div className="card-body">
            <Loading rows={5} />
          </div>
        ) : data && data.length === 0 ? (
          <Empty title={active ? 'No investigations match' : 'No investigations yet'} icon={active ? 'search' : 'flask'}>
            <p>{active ? 'Try a different search or clear the filters.' : 'Run a sample investigation from the top bar, or investigate a GitHub Actions run from Integrations.'}</p>
          </Empty>
        ) : (
          data && (
            <>
              <RecentTable rows={data} />
              <div className="card-foot xs faint" aria-live="polite">
                {data.length} {data.length === 1 ? 'investigation' : 'investigations'}
                {active ? ' match' : ''}
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}
