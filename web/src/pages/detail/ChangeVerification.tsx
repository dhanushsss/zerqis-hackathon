import { Link } from 'react-router-dom';
import type { Bundle, ChangeOutcome, ChangeVerification as Change } from '../../api';
import { Badge, ConfidenceBadge, DiffView, Icon, Sha, VerdictBadge } from '../../components/ui';

/** Display only: outcomes are decided by the backend change-verification rules. */
export const OUTCOME_INFO: Record<ChangeOutcome, { label: string; tone: string; icon: string; help: string }> = {
  regression: { label: 'Regression supported', tone: 'tone-fail', icon: 'fail', help: 'Controlled experiments show tests failing at the changed revision that pass at the base revision.' },
  no_regression_observed: { label: 'No regression observed', tone: 'tone-pass', icon: 'ok', help: 'Every test that ran passed at the changed revision. This covers only what those tests exercise.' },
  inconclusive: { label: 'Inconclusive', tone: 'tone-warn', icon: 'unsure', help: 'The evidence is not sufficient to support a conclusion about the change.' },
  blocked: { label: 'Blocked', tone: 'tone-warn', icon: 'assumption', help: 'The experiments needed to test the change could not run.' },
};

export function OutcomeBadge({ change, lg }: { change: Change | undefined; lg?: boolean }) {
  if (!change?.outcome) return <Badge tone="tone-info" icon="loader">Verifying</Badge>;
  const o = OUTCOME_INFO[change.outcome];
  return (
    <Badge tone={o.tone} icon={o.icon} title={o.help} lg={lg}>
      {o.label}
    </Badge>
  );
}

function fixInfo(c: Change, patches: number): { label: string; tone: string; icon: string; help: string } {
  if (c.fix === 'VALIDATED') return { label: 'Candidate fix validated', tone: 'tone-pass', icon: 'ok', help: 'A candidate passed the failing tests and the full suite in a fresh sandbox. It is validated against those checks only.' };
  if (c.fix === 'REJECTED') return { label: 'Candidate fix rejected', tone: 'tone-fail', icon: 'fail', help: 'Every candidate failed validation. Do not apply them.' };
  if (c.outcome === 'no_regression_observed') return { label: 'No fix needed', tone: 'tone-neutral', icon: 'pending', help: 'No test failed at the changed revision.' };
  return patches
    ? { label: 'No validated fix', tone: 'tone-neutral', icon: 'pending', help: 'No candidate passed validation.' }
    : { label: 'No fix proposed', tone: 'tone-neutral', icon: 'pending', help: 'No candidate fix was proposed.' };
}

function origin(c: Change) {
  return c.origin.kind === 'sample' ? (
    <span>
      Sample repository <span className="mono">{c.origin.scenarioId}</span>
    </span>
  ) : (
    <a href={c.origin.url} target="_blank" rel="noreferrer">
      {c.origin.url.replace('https://', '')}
    </a>
  );
}

const RESULT: Record<string, [string, string, string]> = {
  passed: ['tone-pass', 'ok', 'Passed'],
  failed: ['tone-fail', 'fail', 'Failed'],
  error: ['tone-warn', 'assumption', 'Could not run'],
  skipped: ['tone-neutral', 'skip', 'Not run'],
};

export function ChangeVerificationPanel({ b }: { b: Bundle }) {
  const inv = b.investigation;
  const c = inv.change;
  if (!c) return null;
  const base = `/investigations/${inv.id}`;
  const fix = fixInfo(c, b.patches.length);
  const files = c.changedFiles ?? [];
  const repoUrl = c.origin.kind === 'github' ? c.origin.url : null;

  return (
    <section className="card" aria-labelledby="change-title">
      <div className="card-body stack-md">
        <div className="row-wrap" style={{ gap: 10 }}>
          <h2 id="change-title">Change verification</h2>
          <span className="spacer" />
          <OutcomeBadge change={c} lg />
          {c.outcome && (
            <Badge tone={fix.tone} icon={fix.icon} title={fix.help}>
              {fix.label}
            </Badge>
          )}
          {inv.verdict && (
            <span className="row" style={{ gap: 6 }} title="Diagnosis of the failure, from the ordinary investigation stages">
              <span className="xs muted">Diagnosis</span>
              <VerdictBadge verdict={inv.verdict} />
              <ConfidenceBadge label={inv.confidence?.label} />
            </span>
          )}
        </div>
        <p className="prose">{c.outcomeDetail ?? 'Running the test suite at both revisions in the sandbox. The outcome is decided only from those results.'}</p>

        <dl className="kv">
          <dt>Base revision</dt>
          <dd>
            <Sha sha={c.baseSha ?? c.requested.base} n={12} to={repoUrl && c.baseSha ? `${repoUrl}/commit/${c.baseSha}` : undefined} />
            {!c.baseSha && c.outcome && <span className="xs muted"> (requested; not resolved)</span>}
          </dd>
          <dt>Changed revision</dt>
          <dd>
            <Sha sha={c.headSha ?? c.requested.head} n={12} to={repoUrl && c.headSha ? `${repoUrl}/commit/${c.headSha}` : undefined} />
            {!c.headSha && c.outcome && <span className="xs muted"> (requested; not resolved)</span>}
          </dd>
          <dt>Repository</dt>
          <dd>{origin(c)}</dd>
          {c.fromInvestigationId && (
            <>
              <dt>Started from</dt>
              <dd>
                <Link to={`/investigations/${c.fromInvestigationId}`}>Investigation {c.fromInvestigationId.slice(-6)}</Link>
              </dd>
            </>
          )}
          <dt>Author or agent</dt>
          <dd className="muted">Not identified. Verification covers what the change does, not who or what wrote it.</dd>
        </dl>

        <div className="stack-sm">
          <h3>Scope of the conclusion</h3>
          {c.examined.length ? (
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Full test-suite runs at each revision</caption>
                <thead>
                  <tr>
                    <th scope="col">Revision</th>
                    <th scope="col">Commit</th>
                    <th scope="col">Result</th>
                    <th scope="col" className="num">Tests</th>
                    <th scope="col">Experiment</th>
                  </tr>
                </thead>
                <tbody>
                  {c.examined.map((r) => {
                    const [tone, icon, label] = RESULT[r.status] ?? RESULT.skipped;
                    return (
                      <tr key={r.experimentId}>
                        <td>{r.revision === 'head' ? 'Changed' : 'Base'}</td>
                        <td>
                          <Sha sha={r.sha} n={10} />
                        </td>
                        <td>
                          <Badge tone={tone} icon={icon}>
                            {label}
                          </Badge>
                        </td>
                        <td className="num mono">{r.tests ? `${r.tests.failed} failed / ${r.tests.total}` : '—'}</td>
                        <td>
                          <Link to={`${base}/experiments/${r.experimentId}`}>Full suite</Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">{c.outcome ? 'No test suite ran at either revision.' : 'Not run yet.'}</p>
          )}
        </div>

        {c.notTested.length > 0 && (
          <div className="stack-sm">
            <h3>Not examined</h3>
            <ul className="bullets small">
              {c.notTested.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}

        {files.length > 0 && (
          <div className="stack-sm">
            <h3>
              Changed files <span className="xs muted">({files.length})</span>
            </h3>
            <ul className="file-list small">
              {files.map((f) => (
                <li key={f.path}>
                  <Icon name="file" /> <span className="mono">{f.path}</span>{' '}
                  <span className="xs mono" style={{ color: 'var(--ok)' }}>+{f.additions}</span>{' '}
                  <span className="xs mono" style={{ color: 'var(--fail)' }}>−{f.deletions}</span>
                </li>
              ))}
            </ul>
            {c.diff && (
              <details className="disclosure">
                <summary>Show diff{c.diffTruncated ? ' (truncated)' : ''}</summary>
                <DiffView diff={c.diff} />
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
