import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Bundle, type Patch } from '../../api';
import { BRAND } from '../../brand';
import { AttemptStrip, Badge, Callout, DiffView, ExpStatus, Icon, useChangeFlash, useToast } from '../../components/ui';
import { patchRisks } from './derive';

const STEPS = ['Proposed', 'Validation running', 'Validated', 'PR created'] as const;

function Lifecycle({ p, prUrl }: { p: Patch; prUrl: string | null }) {
  const idx = prUrl ? 3 : p.status === 'validated' ? 2 : p.status === 'validating' ? 1 : p.status === 'failed' ? 2 : 0;
  return (
    <div className="lifecycle" aria-label={`Patch status: ${prUrl ? 'PR created' : p.status}`}>
      {STEPS.map((s, i) => {
        const failedHere = p.status === 'failed' && i === 2;
        const label = failedHere ? 'Validation failed' : s;
        const cls = failedHere ? 'bad' : i < idx ? 'done' : i === idx ? 'current' : '';
        const icon = failedHere ? 'fail' : i < idx || (i === idx && (i === 2 || i === 3)) ? 'ok' : i === idx && i === 1 ? 'loader' : i === idx ? 'target' : 'pending';
        return (
          <span key={s} className="row" style={{ gap: 0 }}>
            {i > 0 && <span className="arrow" aria-hidden="true" />}
            <span className={`lc ${cls}`}>
              <Icon name={icon} className={icon === 'loader' ? 'spin' : undefined} />
              {label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function PatchCard({ p, b, publicDemo }: { p: Patch; b: Bundle; publicDemo: boolean }) {
  const toast = useToast();
  const inv = b.investigation;
  const [busy, setBusy] = useState<'pr' | 'validate' | null>(null);
  const [prUrl, setPrUrl] = useState(p.prUrl);
  const [confirming, setConfirming] = useState(false);
  // Highlight the changed lines only when a validation that was running actually passes.
  const justValidated = useChangeFlash(p.status, (a, b) => a === 'validating' && b === 'validated', 1800);

  const validation = b.experiments.filter((e) => e.patchId === p.id);
  const latestTargeted = [...validation].reverse().find((e) => e.kind === 'validate_patch');
  const latestSuite = [...validation].reverse().find((e) => e.kind === 'regression_suite');
  // Short diffs stay open; long ones (e.g. whole-file reverts) are one click away.
  const diffLines = p.diff.split('\n').length;
  const invRunning = inv.status === 'running' || inv.status === 'queued';
  const canPr = inv.source === 'github' && p.status === 'validated' && !publicDemo;
  const prReason = publicDemo ? 'Disabled on the public demo.' : inv.source !== 'github' ? 'Draft PRs are for GitHub investigations; demo fixtures are local repositories. Download the .diff instead.' : p.status !== 'validated' ? 'Only validated patches can be proposed.' : 'Create a fix branch and a draft PR on GitHub';

  const createPr = async () => {
    setBusy('pr');
    try {
      const res = await api.createPr(p.id);
      setPrUrl(res.url);
      toast('Draft pull request created.');
    } catch (e) {
      toast(`${(e as Error).message}${(e as { hint?: string }).hint ? ` — ${(e as { hint?: string }).hint}` : ''}`, true);
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };
  const revalidate = async () => {
    setBusy('validate');
    try {
      await api.validatePatch(p.id);
      toast('Validation started in a fresh sandbox.');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  const tone = p.status === 'validated' ? 'tone-pass' : p.status === 'failed' ? 'tone-fail' : p.status === 'validating' ? 'tone-info' : 'tone-neutral';
  const statusLabel = prUrl ? 'PR created' : p.status === 'validated' ? 'Validated fix' : p.status === 'failed' ? 'Validation failed' : p.status === 'validating' ? 'Validating' : 'Proposed — not validated';

  return (
    <article id={`patch-card-${p.id}`} tabIndex={-1} className={`card patch ${p.status}`} aria-labelledby={`patch-${p.id}`}>
      <div className="card-head">
        <div className="stack-xs" style={{ minWidth: 0 }}>
          <div className="row-wrap">
            <Badge tone={tone} icon={p.status === 'validated' ? 'ok' : p.status === 'failed' ? 'fail' : p.status === 'validating' ? 'loader' : 'pending'}>
              {statusLabel}
            </Badge>
            <h3 id={`patch-${p.id}`} className="wrap-any">
              {p.title}
            </h3>
          </div>
          <div className="row-wrap xs muted">
            <span>{p.strategy.replace(/_/g, ' ')}</span>·<span>{p.origin === 'deterministic' ? 'deterministic rule' : p.origin === 'replay' ? 'model output (replay)' : p.origin === 'model' ? 'model-written' : 'heuristic'}</span>
          </div>
        </div>
        <div className="row-wrap">
          <a className="btn btn-sm" href={`/api/patches/${p.id}.diff`} download>
            <Icon name="download" /> Download .diff
          </a>
          <button className="btn btn-sm" onClick={revalidate} disabled={busy !== null || invRunning || p.status === 'validating'} aria-busy={busy === 'validate'} title="Apply the patch to a fresh checkout and re-run the failing selection plus the regression suite">
            <Icon name="refresh" className={busy === 'validate' || p.status === 'validating' ? 'spin' : undefined} />
            {p.status === 'validating' ? 'Validating…' : p.status === 'proposed' ? 'Validate fix' : 'Re-validate'}
          </button>
          {prUrl ? (
            <a className="btn btn-sm" href={prUrl} target="_blank" rel="noreferrer">
              <Icon name="external" /> View draft PR
            </a>
          ) : (
            <button className="btn btn-sm" disabled={!canPr || busy !== null} onClick={() => setConfirming(true)} title={prReason}>
              <Icon name="pr" /> Draft PR
            </button>
          )}
        </div>
      </div>
      <div className="card-body stack-md">
        <Lifecycle p={p} prUrl={prUrl} />
        {/* Validation first: a fix is only as good as the runs recorded against it. */}
        <div className="vresult" aria-label="Validation results">
          {latestTargeted ? (
            <>
              <Link to={`/investigations/${inv.id}/experiments/${latestTargeted.id}`} className={`vrow s-${latestTargeted.status}`}>
                <ExpStatus exp={latestTargeted} />
                <span className="vrow-label">
                  <strong>Targeted runs</strong> of the failing tests
                </span>
                <AttemptStrip exp={latestTargeted} />
                <span className="vrow-result">
                  Targeted: {latestTargeted.result ? `${latestTargeted.result.passes}/${latestTargeted.result.attempts.length} runs passed` : latestTargeted.status}
                </span>
              </Link>
              {latestSuite ? (
                <Link to={`/investigations/${inv.id}/experiments/${latestSuite.id}`} className={`vrow s-${latestSuite.status}`}>
                  <ExpStatus exp={latestSuite} />
                  <span className="vrow-label">
                    <strong>Full regression suite</strong> with the fix applied
                  </span>
                  <AttemptStrip exp={latestSuite} />
                  <span className="vrow-result">Regression suite: {latestSuite.status === 'passed' ? 'passed' : latestSuite.status === 'failed' ? 'failed' : latestSuite.status}</span>
                </Link>
              ) : (
                <p className="vrow vrow-note">
                  <Icon name={latestTargeted.testSelection?.startsWith('full') ? 'info' : 'skip'} />
                  <span className="vrow-label">
                    <strong>Full regression suite</strong>
                  </span>
                  <span className="vrow-result muted">
                    {latestTargeted.testSelection?.startsWith('full') ? 'Targeted run was the full build and suite.' : latestTargeted.status === 'failed' ? 'Suite not run: targeted runs failed.' : 'Suite pending.'}
                  </span>
                </p>
              )}
            </>
          ) : (
            <p className="vrow vrow-note">
              <Icon name="pending" />
              <span className="vrow-label">No test has run against this patch.</span>
              <span className="vrow-result muted">{p.status === 'proposed' ? 'Proposed only: not validated.' : 'No validation run is recorded for this patch.'}</span>
            </p>
          )}
        </div>
        <div className="patch-grid">
          <div className="stack-xs">
            <span className="eyebrow">Why this action</span>
            <p className="small">{p.rationale}</p>
          </div>
          <div className="stack-xs">
            <span className="eyebrow">Files changed</span>
            <ul className="files">
              {p.files.map((f) => (
                <li key={f}>
                  <Icon name="file" />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="stack-xs">
          <span className="eyebrow">Remaining risks</span>
          <ul className="risk">
            {patchRisks({ ...p, prUrl }).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
        {diffLines <= 40 ? (
          <DiffView diff={p.diff} flash={justValidated} />
        ) : (
          <details className="disclosure diff-disclosure">
            <summary>
              <Icon name="chevron" /> Show diff ({diffLines} lines across {p.files.length} {p.files.length === 1 ? 'file' : 'files'})
            </summary>
            <div className="disclosure-body">
              <DiffView diff={p.diff} flash={justValidated} />
            </div>
          </details>
        )}
        {confirming && (
          <Callout tone="tone-warn" icon="pr">
            <span>
              Create a branch in <strong>{inv.repository}</strong> containing this diff and open a <strong>draft</strong> pull request. Nothing is merged, and no existing branch is modified.
            </span>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn btn-sm" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="btn btn-sm btn-primary" onClick={createPr} disabled={busy === 'pr'} aria-busy={busy === 'pr'}>
                {busy === 'pr' ? 'Creating…' : 'Create draft PR'}
              </button>
            </div>
          </Callout>
        )}
      </div>
    </article>
  );
}

export function Remediation({ b, publicDemo }: { b: Bundle; publicDemo: boolean }) {
  const inv = b.investigation;
  if (!b.patches.length) {
    const done = inv.status === 'completed' || inv.status === 'inconclusive';
    return (
      <Callout icon={inv.remediationType === 'retry' ? 'refresh' : 'info'}>
        {inv.remediationType === 'retry'
          ? `Likely transient. Re-run the failed job; ${BRAND.name} does not propose code changes for infrastructure failures.`
          : done
            ? `No candidate fix was justified by the evidence. ${BRAND.name} makes a conservative recommendation when the cause is not proven.`
            : inv.status === 'failed'
              ? 'The investigation stopped before remediation.'
              : 'Candidate fixes are proposed and validated after the verdict.'}
      </Callout>
    );
  }
  return (
    <div className="stack-md">
      {b.patches.map((p) => (
        <PatchCard key={p.id} p={p} b={b} publicDemo={publicDemo} />
      ))}
    </div>
  );
}
