import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { Investigation } from '../../api';
import { CLASS_LABEL, ConfidenceBadge, EXP_KIND, HypStatusBadge, Icon, Loading, Logo, usePrefersReducedMotion, VerdictBadge } from '../../components/ui';
import { frameworkLabel, loadSample, recordedDate, shortSha, type Sample, type SampleExperiment } from './sampleData';

export const STEPS = [
  { key: 'failure', label: 'Failure', icon: 'fail' },
  { key: 'hypotheses', label: 'Hypotheses', icon: 'bulb' },
  { key: 'experiments', label: 'Experiments', icon: 'flask' },
  { key: 'diagnosis', label: 'Diagnosis', icon: 'target' },
  { key: 'fix', label: 'Fix validation', icon: 'shield' },
] as const;

const STEP_MS = 2600;

export interface WalkthroughHandle {
  /** Restart from the first stage and play (unless the user prefers reduced motion). */
  restart(): void;
}

export function Attempts({ e }: { e: Pick<SampleExperiment, 'attempts'> }) {
  return (
    <span className="attempts" role="img" aria-label={`${e.attempts.filter((p) => !p).length} of ${e.attempts.length} runs failed`}>
      {e.attempts.map((passed, i) => (
        <span key={i} className={`attempt ${passed ? 'pass' : 'fail'}`} aria-hidden="true" />
      ))}
    </span>
  );
}

/** "1/1 run failed — failing: …" → "1/1 run failed" */
export const headline = (observation: string) => observation.split(' — ')[0].replace(/\s*\(observed.*$/, '');

/** What the investigation knew at each stage; never shows a result before its stage. */
function stageStatus(s: Sample, step: number): { tone: string; icon: string; label: string } {
  switch (STEPS[step].key) {
    case 'failure':
      return { tone: 'tone-fail', icon: 'fail', label: 'CI failed' };
    case 'hypotheses':
    case 'experiments':
      return { tone: 'tone-info', icon: 'flask', label: 'Investigating' };
    case 'diagnosis':
      return { tone: 'tone-neutral', icon: 'target', label: 'Diagnosed' };
    default: {
      const ok = s.patches.filter((p) => p.status === 'validated').length;
      return ok ? { tone: 'tone-pass', icon: 'ok', label: `Fix validated · ${ok} of ${s.patches.length}` } : { tone: 'tone-warn', icon: 'unsure', label: 'No fix validated' };
    }
  }
}

function StepBody({ s, step }: { s: Sample; step: number }) {
  switch (STEPS[step].key) {
    case 'failure':
      return (
        <div className="stack-sm">
          <p className="pw-label">Failure signature</p>
          <pre className="mk-sig">{s.signature}</pre>
          <ul className="pw-facts">
            {s.facts
              // The signature already names the failing tests; list what the log and diff add.
              .filter((f) => !/^(CI log loaded|Failing test)/.test(f))
              .slice(0, 3)
              .map((f) => (
                <li key={f}>
                  <Icon name="eye" /> <span className="mk-clamp">{f}</span>
                </li>
              ))}
          </ul>
        </div>
      );
    case 'hypotheses':
      return (
        <div className="stack-sm">
          <p className="pw-label">Competing explanations, formed before any experiment ran</p>
          <ul className="mk-list">
            {s.hypotheses.map((h) => (
              <li key={h.key}>
                <span className="badge tone-model square">{h.key}</span>
                <span className="mk-clamp">{h.cause}</span>
                <HypStatusBadge status="open" />
              </li>
            ))}
          </ul>
        </div>
      );
    case 'experiments':
      return (
        <div className="stack-sm">
          <p className="pw-label">Experiment timeline · sandboxed runs</p>
          <ul className="mk-list">
            {s.experiments.map((e) => (
              <li key={e.id}>
                <Icon name={e.failures ? 'fail' : 'ok'} className={e.failures ? 'mk-bad' : 'mk-ok'} />
                <span className="stack-xs" style={{ minWidth: 0 }}>
                  <strong className="small">{EXP_KIND[e.kind] ?? e.title}</strong>
                  <span className="xs muted">
                    {e.commit === 'parent' ? 'Parent' : 'Failing'} commit <span className="mono">{shortSha(e.sha)}</span> · {headline(e.observation)}
                  </span>
                </span>
                <Attempts e={e} />
              </li>
            ))}
          </ul>
        </div>
      );
    case 'diagnosis':
      return (
        <div className="stack-sm">
          <div className="row-wrap">
            <VerdictBadge verdict={s.verdict as Investigation['verdict']} />
            <strong>{CLASS_LABEL[s.classification] ?? s.classification}</strong>
            <ConfidenceBadge label={s.confidence} />
          </div>
          <p className="small mk-clamp-3">{s.summary}</p>
          <ul className="mk-list mk-list-tight">
            {s.hypotheses.map((h) => (
              <li key={h.key}>
                <span className="badge tone-model square">{h.key}</span>
                <span className="mk-clamp xs muted">{h.cause}</span>
                <HypStatusBadge status={h.status} />
              </li>
            ))}
          </ul>
        </div>
      );
    case 'fix':
      return (
        <div className="stack-sm">
          <p className="pw-label">Candidate fixes · each applied to a fresh checkout</p>
          <ul className="mk-list">
            {s.patches.map((p) => (
              <li key={p.id}>
                <Icon name={p.status === 'validated' ? 'ok' : 'fail'} className={p.status === 'validated' ? 'mk-ok' : 'mk-bad'} />
                <span className="stack-xs" style={{ minWidth: 0 }}>
                  <strong className="small mk-clamp">{p.title}</strong>
                  <span className="xs muted">{p.summary}</span>
                </span>
                <span className={`badge ${p.status === 'validated' ? 'tone-pass' : 'tone-fail'}`}>{p.status === 'validated' ? 'Validated' : 'Rejected'}</span>
              </li>
            ))}
          </ul>
        </div>
      );
  }
}

/**
 * Steps through a recorded sample investigation inside a product window. The data is a
 * stored run against a bundled sample repository; nothing executes and no provider is called.
 */
export const SampleWalkthrough = forwardRef<WalkthroughHandle, { id?: 'code-regression' }>(function SampleWalkthrough({ id = 'code-regression' }, ref) {
  const reduced = usePrefersReducedMotion();
  const [sample, setSample] = useState<Sample | null>(null);
  const [error, setError] = useState(false);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let live = true;
    loadSample(id).then(
      (s) => {
        if (!live) return;
        setSample(s);
        // Reduced motion: show the outcome straight away and never autoplay.
        if (reduced) setStep(STEPS.length - 1);
        else setPlaying(true);
      },
      () => live && setError(true),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!playing) return;
    if (step >= STEPS.length - 1) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => setStep((n) => n + 1), STEP_MS);
    return () => window.clearTimeout(t);
  }, [playing, step]);

  useImperativeHandle(ref, () => ({
    restart() {
      setStep(0);
      setPlaying(!reduced);
    },
  }), [reduced]);

  const done = step === STEPS.length - 1;
  const toggle = () => {
    if (playing) return setPlaying(false);
    if (done) setStep(0);
    setPlaying(true);
  };
  const status = sample ? stageStatus(sample, step) : null;

  return (
    <section className="mk-sample pw" aria-labelledby="mk-sample-title">
      <div className="pw-chrome">
        <span className="pw-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="badge tone-outline">
          <Icon name="refresh" /> Sample investigation
        </span>
        {sample && <span className="xs faint pw-recorded">Recorded run · {recordedDate(sample.recordedAt)}</span>}
        <span className="spacer" />
        <button className="btn btn-sm" onClick={toggle} disabled={!sample} aria-label={playing ? 'Pause sample' : done ? 'Replay sample' : 'Play sample'}>
          <Icon name={playing ? 'pause' : done ? 'refresh' : 'play'} />
          {playing ? 'Pause' : done ? 'Replay' : 'Play'}
        </button>
      </div>

      <div className="pw-body">
        <div className="pw-side">
          <span className="pw-brand" aria-hidden="true">
            <Logo size={18} /> Investigation
          </span>
          <ol className="mk-steps" aria-label="Investigation stages">
            {STEPS.map((st, i) => (
              <li key={st.key}>
                <button
                  type="button"
                  className={`mk-step ${i < step ? 'is-done' : ''} ${i === step ? 'is-current' : ''}`}
                  aria-current={i === step ? 'step' : undefined}
                  onClick={() => {
                    setPlaying(false);
                    setStep(i);
                  }}
                  disabled={!sample}
                >
                  <span className="mk-step-ico" aria-hidden="true">
                    <Icon name={i < step ? 'check' : st.icon} />
                  </span>
                  {st.label}
                </button>
              </li>
            ))}
          </ol>
        </div>

        <div className="pw-main">
          {error ? (
            <p className="small muted">The sample could not be loaded.</p>
          ) : !sample ? (
            <Loading rows={4} label="Loading sample" />
          ) : (
            <>
              <div className="pw-head">
                <span className="pw-crumbs xs faint">Investigations / {sample.repo}</span>
                <div className="row-wrap" style={{ gap: 10 }}>
                  {status && (
                    <span className={`badge ${status.tone}`}>
                      <Icon name={status.icon} /> {status.label}
                    </span>
                  )}
                  <h2 id="mk-sample-title" className="pw-title">
                    {`${sample.repo} · ${frameworkLabel(sample.framework)}`}
                  </h2>
                </div>
                {sample.commitMessage && <p className="small muted pw-commit mk-clamp">{sample.commitMessage}</p>}
                <dl className="pw-meta">
                  <div>
                    <dt>Commit</dt>
                    <dd className="mono">{shortSha(sample.sha)}</dd>
                  </div>
                  {sample.parentSha && (
                    <div>
                      <dt>Parent</dt>
                      <dd className="mono">{shortSha(sample.parentSha)}</dd>
                    </div>
                  )}
                  {sample.branch && (
                    <div>
                      <dt>Branch</dt>
                      <dd>{sample.branch}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Framework</dt>
                    <dd>{frameworkLabel(sample.framework)}</dd>
                  </div>
                </dl>
              </div>
              <div key={step} className="mk-step-panel pw-panel">
                <StepBody s={sample} step={step} />
              </div>
            </>
          )}
        </div>
      </div>
      <p className="mk-sample-foot xs faint">
        A stored run against a bundled sample repository, shown step by step. Nothing runs and no model is called on this page.
      </p>
    </section>
  );
});
