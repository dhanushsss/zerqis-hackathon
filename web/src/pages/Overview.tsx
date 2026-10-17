import { Link, useNavigate } from 'react-router-dom';
import { api, type Investigation } from '../api';
import { readiness } from '../readiness';
import { ScenarioPicker } from '../components/RunSample';
import { ClassBadge, CLASS_LABEL, Empty, ErrorBox, Icon, Loading, ModeBadge, modeDecided, SectionHead, Sha, StatusBadge, TimeAgo, VerdictCell } from '../components/ui';
import { useApi } from '../hooks';

function Bars({ data, labels, empty }: { data: Record<string, number>; labels?: Record<string, string>; empty: string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  if (!entries.length) return <p className="small faint">{empty}</p>;
  return (
    <div className="bars">
      {entries.map(([k, n]) => (
        <div className="barrow" key={k}>
          <span className="truncate">{labels?.[k] ?? k}</span>
          <span className="track" aria-hidden="true">
            <span className="fill" style={{ width: `${(n / max) * 100}%` }} />
          </span>
          <span className="n">{n}</span>
        </div>
      ))}
    </div>
  );
}

export function RecentTable({ rows }: { rows: Investigation[] }) {
  const navigate = useNavigate();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Repository</th>
            <th>Status</th>
            <th>Verdict</th>
            <th>Classification</th>
            <th>Commit</th>
            <th>Reasoning</th>
            <th className="num">Started</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((inv) => (
            <tr key={inv.id} className="clickable" onClick={() => navigate(`/investigations/${inv.id}`)}>
              <td className="nowrap">
                <Link className="row-link repo" to={`/investigations/${inv.id}`} onClick={(e) => e.stopPropagation()}>
                  {inv.repository}
                </Link>
                <div className="cell-sub">{inv.source === 'demo' ? 'Demo fixture' : `GitHub run ${inv.runId}`}</div>
              </td>
              <td className="nowrap">
                <StatusBadge status={inv.status} />
              </td>
              <td className="nowrap">
                <VerdictCell verdict={inv.verdict} confidence={inv.verdict ? inv.confidence?.label : null} />
              </td>
              <td className="nowrap">
                <ClassBadge value={inv.classification} />
              </td>
              <td className="col-commit">
                <div className="row">
                  <Sha sha={inv.commitSha} />
                  <span className="truncate muted">{inv.commitMessage}</span>
                </div>
              </td>
              <td className="nowrap">
                <ModeBadge mode={inv.mode} pending={!modeDecided(inv)} />
              </td>
              <td className="num muted nowrap">
                <TimeAgo iso={inv.createdAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Overview({ onRunSample }: { onRunSample: () => void }) {
  const { data, error, loading, reload } = useApi(() => api.overview(), [], (d) => (d?.byStatus.running || d?.byStatus.queued ? 3000 : null));
  const status = useApi(() => api.status(), []);

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Overview</h1>
          <p className="lead">
            Alibi investigates failed CI builds. It forms competing hypotheses, runs controlled experiments in a sandbox, and only confirms a cause when an experiment proves it.
          </p>
        </div>
        <div className="page-actions">
          <Link to="/investigations" className="btn">
            View history
          </Link>
          <button className="btn btn-primary" onClick={onRunSample}>
            <Icon name="play" /> Run sample investigation
          </button>
        </div>
      </div>

      {status.data && readiness(status.data).some((r) => !r.ok) && (
        <div className="callout" role="note">
          <Icon name="plug" />
          <div className="row-wrap" style={{ flex: 1, gap: '6px 16px' }}>
            {readiness(status.data).map((r) => (
              <span key={r.key} className="row small" style={{ gap: 6 }}>
                <Icon name={r.ok ? 'ok' : r.failing ? 'fail' : 'skip'} className="" />
                <span className="strong">{r.label}</span>
                <span className="muted">{r.state}</span>
              </span>
            ))}
            <span className="spacer" />
            <Link to="/integrations" className="small">
              Set up integrations
            </Link>
          </div>
        </div>
      )}

      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Loading rows={4} />}
      {data && (
        <>
          <section aria-label="Metrics" className="grid cols-4">
            <div className="card metric">
              <div className="label">
                <Icon name="list" /> Investigations
              </div>
              <div className="value">{data.totals.investigations}</div>
              <div className="hint">
                {data.bySource.github ?? 0} from GitHub · {data.bySource.demo ?? 0} demo fixtures
              </div>
            </div>
            <div className="card metric">
              <div className="label">
                <Icon name="flask" /> Experiments executed
              </div>
              <div className="value">{data.totals.experiments}</div>
              <div className="hint">{data.totals.executedRuns} sandboxed test runs</div>
            </div>
            <div className="card metric">
              <div className="label">
                <Icon name="ok" /> Validated fixes
              </div>
              <div className="value">{data.totals.validatedFixes}</div>
              <div className="hint">of {data.totals.patchesTotal} candidates tested</div>
            </div>
            <div className="card metric">
              <div className="label">
                <Icon name="target" /> Confirmed verdicts
              </div>
              <div className="value">{data.byVerdict.confirmed ?? 0}</div>
              <div className="hint">
                {data.byVerdict.probable ?? 0} probable · {data.byVerdict.inconclusive ?? 0} inconclusive
              </div>
            </div>
          </section>

          <section aria-labelledby="start-title">
            <SectionHead id="start-title" title="Start an investigation" hint="Three deterministic scenarios, one per failure class" />
            <ScenarioPicker />
          </section>

          <section aria-labelledby="recent-title">
            <SectionHead
              id="recent-title"
              title="Recent investigations"
              action={
                <Link to="/investigations" className="small">
                  View all
                </Link>
              }
            />
            <div className="card">
              {data.recent.length === 0 ? (
                <Empty title="No investigations yet" icon="flask">
                  <p>Pick a scenario above. Alibi will reproduce the failure, test competing explanations, and validate a fix.</p>
                </Empty>
              ) : (
                <RecentTable rows={data.recent} />
              )}
            </div>
          </section>

          <section aria-labelledby="diag-title">
            <SectionHead id="diag-title" title="Diagnoses" hint="Across all stored investigations" />
            <div className="grid cols-2">
              <div className="card card-body">
                <h3 style={{ marginBottom: 14 }}>Failure classification</h3>
                <Bars data={data.byClassification} labels={CLASS_LABEL} empty="No classified failures yet." />
              </div>
              <div className="card card-body">
                <h3 style={{ marginBottom: 14 }}>Verdict outcomes</h3>
                <Bars data={data.byVerdict} labels={{ confirmed: 'Confirmed', probable: 'Probable', inconclusive: 'Inconclusive' }} empty="No verdicts yet." />
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
