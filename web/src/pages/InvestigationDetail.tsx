import { useMemo } from 'react';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { api, type Bundle } from '../api';
import { Callout, Empty, ErrorBox, Loading, SectionHead } from '../components/ui';
import { useApi } from '../hooks';
import { isDiagnostic } from './detail/derive';
import { EvidencePath } from './detail/EvidencePath';
import { ExperimentList } from './detail/Experiments';
import { Header, Progress } from './detail/Header';
import { Hypotheses } from './detail/Hypotheses';
import { Ledger } from './detail/Ledger';
import { Remediation } from './detail/Remediation';
import { LogTab, ModelCalls, Sources } from './detail/Tabs';
import { Verdict } from './detail/Verdict';

function Summary({ b, publicDemo }: { b: Bundle; publicDemo: boolean }) {
  const inv = b.investigation;
  const base = `/investigations/${inv.id}`;
  return (
    <div className="stack">
      <EvidencePath b={b} />
      <Verdict b={b} />
      <section aria-labelledby="sig-title">
        <SectionHead
          id="sig-title"
          title="Failure signature"
          hint="Parsed deterministically from the CI log"
          action={
            <Link to={`${base}/log`} className="small">
              Open CI log
            </Link>
          }
        />
        <div className="signature">{inv.failureSignature ?? 'Not extracted yet.'}</div>
        {inv.logStats && (
          <p className="xs faint" style={{ marginTop: 6 }}>
            {inv.logStats.totalLines.toLocaleString()} lines ({(inv.logStats.totalChars / 1024).toFixed(0)} KB) · {inv.logStats.excerptCount} relevant {inv.logStats.excerptCount === 1 ? 'excerpt' : 'excerpts'} ({(inv.logStats.sentChars / 1024).toFixed(1)} KB) selected as model context · {inv.logStats.redactions} secret{inv.logStats.redactions === 1 ? '' : 's'} redacted
          </p>
        )}
      </section>
      <section aria-labelledby="hyp-title">
        <SectionHead id="hyp-title" title="Competing hypotheses" hint="Each must survive an experiment" />
        {b.hypotheses.length ? (
          <Hypotheses b={b} />
        ) : (
          <div className="card">
            <Empty title={inv.status === 'failed' ? 'No hypotheses were formed' : 'Forming hypotheses…'} icon="bulb" />
          </div>
        )}
      </section>
      <section aria-labelledby="exp-title">
        <SectionHead
          id="exp-title"
          title="Experiments"
          hint="Executed in an isolated sandbox"
          action={
            <Link to={`${base}/experiments`} className="small">
              All experiments
            </Link>
          }
        />
        <div className="card">
          <ExperimentList b={b} filter={isDiagnostic} />
        </div>
      </section>
      <section aria-labelledby="remediation" id="remediation-section">
        <SectionHead id="remediation" title="Remediation" hint="A fix is validated only if the failing tests and the regression suite pass" />
        <Remediation b={b} publicDemo={publicDemo} />
      </section>
    </div>
  );
}

export function InvestigationDetail() {
  const { id = '' } = useParams();
  const status = useApi(() => api.status(), []);
  const { data, error, loading, reload } = useApi(() => api.investigation(id), [id], (d) =>
    d &&
    (d.investigation.status === 'running' ||
      d.investigation.status === 'queued' ||
      d.patches.some((p) => p.status === 'validating') ||
      d.experiments.some((e) => e.status === 'running'))
      ? 1500
      : null,
  );
  const counts = useMemo(() => (data ? { ledger: data.evidence.length, experiments: data.experiments.length, sources: data.sources.length, models: data.modelCalls.length } : null), [data]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !data) return <Loading rows={6} label="Loading investigation" />;
  if (!data) return null;
  const inv = data.investigation;
  const tab = (to: string, label: string, n?: number) => (
    <NavLink to={to} end>
      {label}
      {n !== undefined && <span className="count">{n}</span>}
    </NavLink>
  );
  return (
    <div className="stack-md">
      <Header b={data} />
      {inv.status === 'failed' && inv.error && (
        <Callout tone="tone-fail" icon="fail">
          <span>
            <strong>Investigation stopped.</strong> {inv.error}
          </span>
        </Callout>
      )}
      <Progress b={data} />
      <div style={{ marginTop: 8 }}>
        <nav className="tabs" aria-label="Investigation sections">
          {tab(`/investigations/${id}`, 'Summary')}
          {tab(`/investigations/${id}/ledger`, 'Evidence ledger', counts?.ledger)}
          {tab(`/investigations/${id}/experiments`, 'Experiments', counts?.experiments)}
          {tab(`/investigations/${id}/sources`, 'Sources', counts?.sources)}
          {tab(`/investigations/${id}/log`, 'CI log')}
          {tab(`/investigations/${id}/models`, 'Model calls', counts?.models)}
        </nav>
        <Routes>
          <Route index element={<Summary b={data} publicDemo={Boolean(status.data?.publicDemo)} />} />
          <Route path="ledger" element={<Ledger b={data} />} />
          <Route
            path="experiments"
            element={
              <div className="stack-md">
                <div className="card">
                  <div className="card-head">
                    <h3>Diagnostic experiments</h3>
                  </div>
                  <ExperimentList b={data} filter={isDiagnostic} />
                </div>
                {data.experiments.some((e) => !isDiagnostic(e)) && (
                  <div className="card">
                    <div className="card-head">
                      <h3>Fix validation</h3>
                    </div>
                    <ExperimentList b={data} filter={(e) => !isDiagnostic(e)} />
                  </div>
                )}
              </div>
            }
          />
          <Route path="sources" element={<Sources b={data} />} />
          <Route path="log" element={<LogTab id={id} />} />
          <Route path="models" element={<ModelCalls b={data} />} />
        </Routes>
      </div>
    </div>
  );
}
