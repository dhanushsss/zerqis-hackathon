import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Scenario } from '../api';
import { useApi } from '../hooks';
import { Badge, ErrorBox, EXP_KIND, Icon, Loading, useToast } from './ui';
import { BRAND } from '../brand';

const ONE_LINER: Record<string, string> = {
  'flaky-jest': 'A docs-only commit turned CI red: is the change guilty, or is the test flaky?',
  'maven-dependency': 'A Dependabot bump to Guava 21.0 broke compilation: which change, and what fixes it?',
  'code-regression': `A refactor broke the $100 discount boundary: can ${BRAND.name} prove it and validate a fix?`,
};

export function ScenarioPicker({ onStarted }: { onStarted?: () => void }) {
  const scenarios = useApi(() => api.scenarios(), []);
  const status = useApi(() => api.status(), []);
  const [mode, setMode] = useState('auto');
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const live = status.data?.nebius.configured;
  const sandbox = status.data?.runner.ok;

  const start = async (s: Scenario) => {
    setBusy(s.id);
    try {
      const inv = await api.startDemo(s.id, mode);
      onStarted?.();
      navigate(`/investigations/${inv.id}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  const autoMeans = live ? 'live Nemotron' : 'replay if recorded, otherwise heuristic';

  return (
    <div className="stack-md">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <label className="row small" style={{ gap: 10 }}>
          <span className="strong">Reasoning</span>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Reasoning mode">
            <option value="auto">Auto ({autoMeans})</option>
            <option value="live" disabled={!live}>
              Live Nemotron{live ? '' : ' (needs NEBIUS_API_KEY)'}
            </option>
            <option value="replay">Replay recorded Nemotron output</option>
            <option value="heuristic">Heuristic rules (no model)</option>
          </select>
        </label>
        <span className="small muted row">
          <Icon name={sandbox === false ? 'fail' : 'shield'} className="" />
          {sandbox === false ? 'Sandbox unavailable: experiments will be skipped' : 'Experiments always execute for real in the sandbox'}
        </span>
      </div>
      {scenarios.error && <ErrorBox error={scenarios.error} onRetry={scenarios.reload} />}
      {scenarios.loading && !scenarios.data && <Loading />}
      <div className="scenarios">
        {scenarios.data?.map((s) => (
          <article key={s.id} className="card interactive scenario" aria-labelledby={`sc-${s.id}`}>
            <div className="row-wrap">
              <Badge tone="tone-outline" icon="box">
                {s.framework === 'maven' ? 'Maven' : s.framework === 'pytest' ? 'pytest' : 'Jest'}
              </Badge>
              <span className="mono xs faint truncate">{s.repository}</span>
            </div>
            <h3 id={`sc-${s.id}`}>{s.title}</h3>
            <p className="small muted">{ONE_LINER[s.id] ?? s.summary}</p>
            {s.expected?.experiments && (
              <div className="plan" aria-label="Planned experiments">
                Tests:
                {s.expected.experiments.map((e) => (
                  <span key={e}>{(EXP_KIND[e] ?? e).toLowerCase()}</span>
                ))}
              </div>
            )}
            <div className="foot">
              <span className="xs faint">{s.replayRecordedAt ? `Replay recorded ${new Date(s.replayRecordedAt).toLocaleDateString()}` : 'Demo fixture · real git history'}</span>
              <span className="spacer" />
              <button className="btn btn-primary btn-sm" onClick={() => start(s)} disabled={busy !== null} aria-busy={busy === s.id} aria-label={`Investigate ${s.title}`}>
                <Icon name={busy === s.id ? 'loader' : 'play'} className={busy === s.id ? 'spin' : undefined} />
                {busy === s.id ? 'Starting…' : 'Investigate'}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export function RunSampleModal({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="sample-title" onClick={(e) => e.stopPropagation()} ref={ref} tabIndex={-1}>
        <div className="card-head">
          <div className="stack-xs">
            <h2 id="sample-title">Run a sample investigation</h2>
            <span className="small muted">Real git repositories, CI logs captured from real runs, and real sandboxed experiments.</span>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="card-body">
          <ScenarioPicker onStarted={onClose} />
        </div>
      </div>
    </div>
  );
}
