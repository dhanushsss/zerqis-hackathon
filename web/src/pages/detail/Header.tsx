import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Bundle } from '../../api';
import { Icon, ModeBadge, modeDecided, MODE_INFO, Sha, StatusBadge, TimeAgo, useChangeFlash, useToast } from '../../components/ui';
import { stages, type Stage, type StageState } from './derive';

export function Header({ b }: { b: Bundle }) {
  const inv = b.investigation;
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const running = inv.status === 'running' || inv.status === 'queued';
  const commitUrl = inv.repoUrl ? `${inv.repoUrl}/commit/${inv.commitSha}` : undefined;

  const rerun = async () => {
    setBusy(true);
    try {
      const next = await api.rerun(inv.id);
      toast(inv.change ? 'Started a new verification of the same change.' : 'Started a new investigation of the same failure.');
      navigate(`/investigations/${next.id}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm('Delete this investigation and its evidence ledger? This cannot be undone.')) return;
    try {
      await api.remove(inv.id);
      toast('Investigation deleted.');
      navigate('/investigations');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <header className="inv-head">
      <div className="inv-head-main">
        <div className="inv-badges">
          <StatusBadge status={inv.status} />
          <ModeBadge mode={inv.mode} pending={!modeDecided(inv)} />
        </div>
        <div className="inv-title">
          <h1>{inv.repository}</h1>
          <Sha sha={inv.commitSha} n={10} to={commitUrl} />
        </div>
        <p className="inv-commit truncate" title={inv.commitMessage ?? undefined}>
          {inv.commitMessage ?? 'Unknown commit message'}
        </p>
        <div className="inv-meta">
          {inv.change ? (
            <span>
              <Icon name="commit" /> base <Sha sha={inv.parentSha} /> → changed <Sha sha={inv.commitSha} />
            </span>
          ) : (
            <>
              <span>
                <Icon name="workflow" /> {inv.workflow ?? 'Workflow'} / {inv.job ?? 'job'}
              </span>
              <span>
                <Icon name="branch" /> <span className="mono">{inv.branch ?? '—'}</span>
              </span>
              <span>
                <Icon name="commit" /> parent <Sha sha={inv.parentSha} />
              </span>
            </>
          )}
          {inv.commitAuthor && (
            <span>
              <Icon name="user" /> {inv.commitAuthor}
            </span>
          )}
          {inv.prUrl && (
            <span>
              <Icon name="pr" />
              <a href={inv.prUrl} target="_blank" rel="noreferrer">
                PR #{inv.prNumber}
              </a>
            </span>
          )}
          <span>
            <Icon name="clock" /> <TimeAgo iso={inv.createdAt} />
          </span>
          <span>
            <Icon name="box" /> {inv.source === 'demo' ? 'Demo fixture' : inv.source === 'change' ? 'Change verification' : 'GitHub Actions'}
          </span>
        </div>
        {/* What the reasoning mode means for this run: kept visible, below the identity of the run. */}
        {modeDecided(inv) && MODE_INFO[inv.mode] && <p className="inv-mode-note">{MODE_INFO[inv.mode].help}</p>}
      </div>
      <div className="page-actions">
        {inv.runUrl && (
          <a className="btn" href={inv.runUrl} target="_blank" rel="noreferrer">
            <Icon name="external" /> Open CI run
          </a>
        )}
        <Link className="btn" to={`/investigations/${inv.id}/log`}>
          <Icon name="terminal" /> {inv.change ? 'Test output' : 'CI log'}
        </Link>
        <button className="btn" onClick={rerun} disabled={busy || running} aria-busy={busy}>
          <Icon name="refresh" className={busy ? 'spin' : undefined} /> Re-run
        </button>
        <button className="btn btn-danger btn-icon" onClick={remove} disabled={running} aria-label="Delete investigation" title="Delete investigation">
          <Icon name="trash" />
        </button>
      </div>
    </header>
  );
}

const STATE_ICON: Record<StageState, string> = { done: 'ok', running: 'loader', pending: 'pending', skipped: 'skip', failed: 'fail', inconclusive: 'unsure' };
const STATE_LABEL: Record<StageState, string> = { done: 'Complete', running: 'In progress', pending: 'Pending', skipped: 'Skipped', failed: 'Failed', inconclusive: 'Inconclusive' };

function StageItem({ s, i }: { s: Stage; i: number }) {
  // Animate only real transitions observed while this page is open (driven by polling).
  const changed = useChangeFlash(s.state);
  return (
    <li className={`pstage ${s.state} ${changed ? 'changed' : ''}`} aria-current={s.state === 'running' ? 'step' : undefined} title={`${s.name}: ${STATE_LABEL[s.state]}`}>
      <span className="ptitle">
        <span className="pnum" aria-hidden="true">
          {i + 1}
        </span>
        <Icon name={STATE_ICON[s.state]} className={s.state === 'running' ? 'spin' : undefined} />
        <span className="pname-full">{s.name}</span>
        <span className="pname-short" aria-hidden="true">
          {s.short}
        </span>
        <span className="sr-only">: {STATE_LABEL[s.state]}</span>
      </span>
      <span className="pmeta">
        <span className="pstate">{STATE_LABEL[s.state]}</span>
        {s.meta ? ` · ${s.meta}` : ''}
      </span>
    </li>
  );
}

export function Progress({ b }: { b: Bundle }) {
  return (
    <ol className="progress" aria-label="Investigation progress" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {stages(b).map((s, i) => (
        <StageItem key={s.key} s={s} i={i} />
      ))}
    </ol>
  );
}
