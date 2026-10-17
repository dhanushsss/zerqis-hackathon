import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Callout, Empty, Icon, Sha, TimeAgo } from '../components/ui';
import { useApi } from '../hooks';
import { OutcomeBadge } from './detail/ChangeVerification';

type Origin = 'sample' | 'investigation' | 'github';
const SHA = /^[0-9a-fA-F]{7,40}$/;

export function VerifyPage() {
  const navigate = useNavigate();
  const [origin, setOrigin] = useState<Origin>('sample');
  const [scenarioId, setScenarioId] = useState('');
  const [investigationId, setInvestigationId] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scenarios = useApi(() => api.scenarios(), []);
  const investigations = useApi(() => api.investigations({}), []);
  const recent = useApi(() => api.investigations({ source: 'change' }), [], (d) => (d?.some((i) => i.status === 'running' || i.status === 'queued') ? 3000 : null));
  const revisions = useApi(() => (origin === 'sample' && scenarioId ? api.sampleRevisions(scenarioId) : Promise.resolve([])), [origin, scenarioId]);
  const candidates = useMemo(() => (investigations.data ?? []).filter((i) => i.source !== 'change' && i.parentSha), [investigations.data]);

  useEffect(() => {
    if (!scenarioId && scenarios.data?.length) setScenarioId(scenarios.data[0].id);
  }, [scenarios.data, scenarioId]);
  useEffect(() => {
    const revs = revisions.data ?? [];
    if (origin === 'sample' && revs.length >= 2) {
      setBase(revs[revs.length - 2].sha);
      setHead(revs[revs.length - 1].sha);
    }
  }, [revisions.data, origin]);

  const needsRevisions = origin !== 'investigation';
  const invalid =
    (origin === 'sample' && !scenarioId) ||
    (origin === 'investigation' && !investigationId) ||
    (origin === 'github' && !repoUrl.trim()) ||
    (needsRevisions && (!SHA.test(base.trim()) || !SHA.test(head.trim())));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        origin === 'sample' ? { scenarioId, base: base.trim(), head: head.trim() }
        : origin === 'investigation' ? { investigationId }
        : { repoUrl: repoUrl.trim(), base: base.trim(), head: head.trim() };
      const inv = await api.startVerification(body);
      navigate(`/investigations/${inv.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Verify a change</h1>
          <p className="lead">
            Check whether a code change, from a pull request, a coding agent, or anyone else, breaks tests that pass at its base revision. Both revisions run in the
            isolated sandbox; the outcome reports only what those tests show. Authorship is not detected or inferred.
          </p>
        </div>
      </div>

      <form className="card card-body stack-md" onSubmit={submit} aria-labelledby="verify-form-title" noValidate>
        <h2 id="verify-form-title" className="sr-only">
          Choose the change to verify
        </h2>
        <fieldset className="choice-group">
          <legend>What to verify</legend>
          {(
            [
              ['sample', 'Sample repository'],
              ['investigation', 'An existing investigation'],
              ['github', 'Public GitHub repository'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="choice">
              <input type="radio" name="origin" value={value} checked={origin === value} onChange={() => setOrigin(value)} />
              {label}
            </label>
          ))}
        </fieldset>

        {origin === 'sample' && (
          <div className="form-grid">
            <label className="field">
              <span>Repository to verify</span>
              <select className="select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
                {(scenarios.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.repository} ({s.framework})
                  </option>
                ))}
              </select>
            </label>
            {(['base', 'head'] as const).map((which) => (
              <label key={which} className="field">
                <span>{which === 'base' ? 'Base revision' : 'Changed revision'}</span>
                <select className="select" value={which === 'base' ? base : head} onChange={(e) => (which === 'base' ? setBase : setHead)(e.target.value)} disabled={!revisions.data?.length}>
                  {(revisions.data ?? []).map((r) => (
                    <option key={r.sha} value={r.sha}>
                      {r.sha.slice(0, 10)} · {r.message}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}

        {origin === 'investigation' && (
          <label className="field">
            <span>Investigation (its parent commit is the base, its commit is the change)</span>
            <select className="select" value={investigationId} onChange={(e) => setInvestigationId(e.target.value)}>
              <option value="">Choose an investigation…</option>
              {candidates.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.repository} · {i.parentSha!.slice(0, 7)} → {i.commitSha.slice(0, 7)} · {i.commitMessage ?? i.id}
                </option>
              ))}
            </select>
            {investigations.data && !candidates.length && <span className="xs muted">No investigation with a known parent commit yet.</span>}
          </label>
        )}

        {origin === 'github' && (
          <div className="form-grid">
            <label className="field">
              <span>Repository URL</span>
              <input className="input" type="url" inputMode="url" placeholder="https://github.com/owner/repo" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              <span>Base revision (commit SHA)</span>
              <input className="input mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder="7–40 hex characters" autoComplete="off" spellCheck={false} aria-invalid={Boolean(base) && !SHA.test(base.trim())} />
            </label>
            <label className="field">
              <span>Changed revision (commit SHA)</span>
              <input className="input mono" value={head} onChange={(e) => setHead(e.target.value)} placeholder="7–40 hex characters" autoComplete="off" spellCheck={false} aria-invalid={Boolean(head) && !SHA.test(head.trim())} />
            </label>
          </div>
        )}
        {origin === 'github' && (
          <p className="xs muted prose">
            Public repositories only. Revisions must be commit SHAs; branch names are not accepted. Supported test setups: Jest, Maven, and pytest (requirements.txt). Anything
            else ends as blocked, with the reason.
          </p>
        )}

        {error && (
          <Callout tone="tone-fail" icon="fail">
            <span role="alert">{error}</span>
          </Callout>
        )}
        <div className="row-wrap">
          <button className="btn btn-primary" type="submit" disabled={busy || invalid} aria-busy={busy}>
            <Icon name="shield" /> Verify change
          </button>
          <span className="xs muted">Runs the full test suite at both revisions offline, then investigates any failure.</span>
        </div>
      </form>

      <section aria-labelledby="recent-verifications">
        <h2 id="recent-verifications" style={{ marginBottom: 10 }}>
          Recent verifications
        </h2>
        <div className="card">
          {recent.data?.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Repository</th>
                    <th scope="col">Base → changed</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.data.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link to={`/investigations/${i.id}`}>{i.repository}</Link>
                      </td>
                      <td className="nowrap">
                        <Sha sha={i.change?.baseSha ?? i.change?.requested.base} /> → <Sha sha={i.change?.headSha ?? i.change?.requested.head} />
                      </td>
                      <td>{i.status === 'failed' ? <span className="small muted">Stopped: {i.error}</span> : <OutcomeBadge change={i.change} />}</td>
                      <td className="nowrap">
                        <TimeAgo iso={i.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No verifications yet" icon="shield">
              Choose a change above. Results appear here and in Investigations.
            </Empty>
          )}
        </div>
      </section>
    </div>
  );
}
