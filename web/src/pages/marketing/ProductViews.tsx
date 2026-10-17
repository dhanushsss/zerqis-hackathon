import { useEffect, useState } from 'react';
import { DiffView, duration, Icon, KIND } from '../../components/ui';
import { Attempts } from './SampleWalkthrough';
import { loadSample, shortSha, type Sample, type SampleId, type SamplePatch, type SampleRun } from './sampleData';

/** Loads one recorded sample (bundled JSON; no API call). */
export function useSample(id: SampleId): { sample: Sample | null; error: boolean } {
  const [sample, setSample] = useState<Sample | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    loadSample(id).then((s) => live && setSample(s), () => live && setError(true));
    return () => {
      live = false;
    };
  }, [id]);
  return { sample, error };
}

function SampleUnavailable() {
  return <p className="small muted">The recorded sample could not be loaded.</p>;
}

function Placeholder({ label, height = 320 }: { label: string; height?: number }) {
  return <div className="mk-placeholder skeleton" style={{ height }} role="status" aria-label={label} />;
}

type Tone = 'fail' | 'pass' | 'model' | 'neutral' | 'warn';

/** Picks the ledger records that tell the story in order, each one a real record. */
function ledgerStory(s: Sample): Array<{ seq: number; kind: string; provenance: string; title: string; label: string; tone: Tone }> {
  const find = (re: RegExp, kind?: string) => s.ledger.find((e) => re.test(e.title) && (!kind || e.kind === kind));
  const picks: Array<[ReturnType<typeof find>, string, Tone]> = [
    [find(/^Failing test|^Compilation error/, 'observed_fact'), 'Failure detected', 'fail'],
    [find(/^Commit changes|^Dependency change/, 'observed_fact'), 'From the diff', 'neutral'],
    [s.ledger.find((e) => e.kind === 'model_hypothesis'), 'Hypothesis to test', 'model'],
    [find(/^Reproduce the failure/, 'experiment_result'), 'Reproduced at the failing commit', 'fail'],
    [find(/^Compare against the parent/, 'experiment_result'), 'Parent commit comparison', 'pass'],
    [find(/^Candidate validated/, 'experiment_result'), 'Fix validated', 'pass'],
    [[...s.ledger].reverse().find((e) => /^Final verdict/.test(e.title)), 'Diagnosis', 'pass'],
  ];
  return picks.filter((p): p is [NonNullable<ReturnType<typeof find>>, string, Tone] => Boolean(p[0])).map(([e, label, tone]) => ({ ...e, label, tone }));
}

const TONE_ICON: Record<Tone, string> = { fail: 'fail', pass: 'ok', model: 'bulb', neutral: 'commit', warn: 'unsure' };

/** Output lines with failures and summaries coloured, as in the app's terminal view. */
function OutputLines({ text, label, max = 14 }: { text: string; label: string; max?: number }) {
  const lines = text.split('\n').slice(-max);
  return (
    // Scrollable, so it must be keyboard-focusable and named.
    <pre className="mk-term-pre" tabIndex={0} role="region" aria-label={label}>
      {lines.map((l, i) => (
        <span key={i} className={/✕|failed|Error|●/.test(l) ? 'ln-err' : /✓|PASS|passed/.test(l) ? 'ln-ok' : /^\s*(at |\d+ \|| \|)/.test(l) ? 'ln-dim' : undefined}>
          {l}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/**
 * The evidence ledger of the recorded code-regression sample, in the dark workspace
 * style: the investigation's record on the left, the diff and test output on the right.
 */
export function EvidenceLedgerPanel() {
  const { sample: s, error } = useSample('code-regression');
  if (error) return <SampleUnavailable />;
  if (!s) return <Placeholder label="Loading the sample evidence ledger" height={420} />;
  const story = ledgerStory(s);
  const reproduce = s.experiments.find((e) => e.kind === 'reproduce');
  const fix = s.patches.find((p) => p.status === 'validated');

  return (
    <figure className="mk-dark" aria-labelledby="mk-ledger-title">
      <figcaption className="mk-dark-head">
        <span id="mk-ledger-title" className="mk-dark-title">
          <Icon name="list" /> Evidence ledger
        </span>
        <span className="mk-dark-meta">
          {s.repo} · {story.length} of {s.ledger.length} records
        </span>
      </figcaption>
      <div className="mk-dark-grid">
        <ol className="mk-dark-timeline">
          {story.map((e) => (
            <li key={e.seq} className={`mk-dt t-${e.tone}`}>
              <span className="mk-dt-dot" aria-hidden="true">
                <Icon name={TONE_ICON[e.tone]} />
              </span>
              <div className="mk-dt-body">
                <span className="mk-dt-label">{e.label}</span>
                <span className="mk-dt-title">{e.title}</span>
                <span className="mk-dt-prov">
                  #{e.seq} · {KIND[e.kind]?.label ?? e.kind} · {e.provenance}
                </span>
              </div>
            </li>
          ))}
        </ol>
        <div className="mk-dark-side">
          {fix && (
            <div className="mk-dark-pane">
              <div className="mk-dark-pane-head">
                <Icon name="file" /> Validated fix · diff
              </div>
              <DiffView diff={trimDiff(fix.diff)} />
            </div>
          )}
          {reproduce?.output && (
            <div className="mk-dark-pane">
              <div className="mk-dark-pane-head">
                <Icon name="terminal" /> Test output · reproduce @ {shortSha(reproduce.sha)}
              </div>
              <OutputLines text={reproduce.output} label="Test output of the reproduce experiment" max={9} />
            </div>
          )}
        </div>
      </div>
    </figure>
  );
}

/** First file of a diff only, so the landing preview stays short. */
function trimDiff(diff: string): string {
  const files = diff.split(/(?=^diff --git )/m);
  return files[0].trimEnd();
}

function RunRow({ icon, label, run, note }: { icon: string; label: string; run: SampleRun; note?: string }) {
  const ok = run.failedRuns === 0;
  return (
    <li className="mk-vrow">
      <Icon name={ok ? 'ok' : 'fail'} className={ok ? 'mk-ok' : 'mk-bad'} />
      <span className="stack-xs" style={{ minWidth: 0 }}>
        <span className="small strong row" style={{ gap: 6 }}>
          <Icon name={icon} className="faint" /> {label}
        </span>
        <span className="xs muted">
          {run.runs} {run.runs === 1 ? 'run' : 'runs'}, {run.failedRuns} failed
          {run.tests && ` · ${run.tests.passed}/${run.tests.total} tests passed`}
          {note && ` · ${note}`}
        </span>
      </span>
      <span className="xs faint tabular">{duration(run.durationMs)}</span>
    </li>
  );
}

function PatchValidation({ p }: { p: SamplePatch }) {
  const ok = p.status === 'validated';
  return (
    <div className="mk-vcard">
      <div className="mk-vcard-head">
        <span className="stack-xs" style={{ minWidth: 0 }}>
          <span className="xs faint">{p.origin === 'model' ? 'Written by a model' : 'Deterministic strategy'}</span>
          <strong className="small mk-clamp">{p.title}</strong>
        </span>
        <span className={`badge ${ok ? 'tone-pass' : 'tone-fail'}`}>
          <Icon name={ok ? 'ok' : 'fail'} /> {ok ? 'Validated' : 'Rejected'}
        </span>
      </div>
      <ul className="mk-vlist">
        {p.targeted && <RunRow icon="target" label="Targeted runs of the failing tests" run={p.targeted} note={p.suite ? undefined : 'full build and suite'} />}
        {p.suite && <RunRow icon="list" label="Full test suite with the fix applied" run={p.suite} />}
      </ul>
    </div>
  );
}

/**
 * Validation of candidate fixes in two recorded samples: a model-written fix that passed
 * both the targeted runs and the full suite, and one that failed and was rejected.
 */
export function ValidationPanel() {
  const cr = useSample('code-regression');
  const mv = useSample('maven-dependency');
  if (cr.error || mv.error) return <SampleUnavailable />;
  if (!cr.sample || !mv.sample) return <Placeholder label="Loading recorded fix validations" />;
  const accepted = cr.sample.patches.find((p) => p.origin === 'model' && p.status === 'validated') ?? cr.sample.patches[0];
  const rejected = mv.sample.patches.find((p) => p.status !== 'validated');
  const env = accepted.environment;

  return (
    <div className="mk-validate" aria-label="Recorded fix validations">
      <div className="mk-vdiff card">
        <div className="card-head">
          <h3 className="small">
            <Icon name="file" /> Proposed fix · {cr.sample.repo}
          </h3>
          <span className="xs faint mono">{shortSha(cr.sample.sha)} + patch</span>
        </div>
        <DiffView diff={trimDiff(accepted.diff)} />
        {env && (
          <p className="mk-env xs faint">
            <Icon name="box" /> Sandbox <span className="mono">{env.image}</span> · network <span className="mono">{env.network}</span> while tests run
            {env.installNetwork && <> · dependency install only: {env.installNetwork.replace(/\s*\(install only\)/, '')}</>}
          </p>
        )}
      </div>
      <div className="mk-vstack">
        <PatchValidation p={accepted} />
        {rejected && (
          <>
            <PatchValidation p={rejected} />
            <p className="xs faint">
              The second card is from the Maven sample ({mv.sample.repo}): its model-written candidate failed every targeted run, so it was rejected and a dependency
              pin was recommended instead.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** Compact, real visuals for the use-case list. */
export function UseCaseVisual({ kind }: { kind: 'regression' | 'flaky' | 'dependency' | 'rejected' }) {
  const id: SampleId = kind === 'flaky' ? 'flaky-jest' : kind === 'regression' ? 'code-regression' : 'maven-dependency';
  const { sample: s } = useSample(id);
  if (!s) return <div className="mk-uv mk-uv-empty" aria-hidden="true" />;

  if (kind === 'regression' || kind === 'flaky') {
    const rows = s.experiments.filter((e) => (kind === 'flaky' ? e.kind === 'repeat' || e.kind === 'compare_parent' : e.kind === 'reproduce' || e.kind === 'compare_parent'));
    return (
      <div className="mk-uv">
        {rows.map((e) => (
          <div key={e.id} className="mk-uv-row">
            <span className="xs muted">
              {e.kind === 'repeat' ? 'Repeated' : e.commit === 'parent' ? 'Parent' : 'Failing'} <span className="mono">{shortSha(e.sha)}</span>
            </span>
            <Attempts e={e} />
          </div>
        ))}
      </div>
    );
  }
  if (kind === 'dependency') {
    const dep = s.facts.find((f) => /^Dependency change/.test(f));
    return (
      <div className="mk-uv">
        <span className="mk-uv-chip mono">{dep?.replace(/^Dependency change:\s*/, '') ?? s.repo}</span>
        <span className="xs muted">Recorded in the ledger from the commit diff</span>
      </div>
    );
  }
  return (
    <div className="mk-uv">
      {s.patches.map((p) => (
        <div key={p.id} className="mk-uv-row">
          <span className="xs muted mk-clamp">{p.origin === 'model' ? 'Model-written fix' : p.title}</span>
          <span className={`badge ${p.status === 'validated' ? 'tone-pass' : 'tone-fail'}`}>{p.status === 'validated' ? 'Validated' : 'Rejected'}</span>
        </div>
      ))}
    </div>
  );
}
