import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Status } from '../api';
import { Badge, Callout, CopyButton, Empty, ErrorBox, Icon, Loading, TimeAgo, useToast } from '../components/ui';
import { BRAND } from '../brand';
import { useApi } from '../hooks';

type Health = 'ok' | 'unconfigured' | 'error' | 'configured';
const HEALTH: Record<Health, { tone: string; icon: string }> = {
  ok: { tone: 'tone-pass', icon: 'ok' },
  configured: { tone: 'tone-info', icon: 'info' },
  unconfigured: { tone: 'tone-neutral', icon: 'skip' },
  error: { tone: 'tone-fail', icon: 'fail' },
};

interface TestState {
  ok: boolean;
  text: string;
  detail?: string;
  at: string;
}

function useTest(run: () => Promise<any>, summarize: (r: any) => string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestState | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      const r = await run();
      setResult({ ok: r?.ok !== false, text: summarize(r), detail: JSON.stringify(r, null, 2), at: new Date().toISOString() });
    } catch (e) {
      const hint = (e as { hint?: string }).hint;
      setResult({ ok: false, text: (e as Error).message, detail: hint, at: new Date().toISOString() });
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, go };
}

function TestResult({ r }: { r: TestState }) {
  return (
    <div className={`callout ${r.ok ? 'tone-pass' : 'tone-fail'}`} role="status" style={{ background: r.ok ? 'var(--ok-soft)' : 'var(--fail-soft)', borderColor: r.ok ? 'var(--ok-line)' : 'var(--fail-line)' }}>
      <Icon name={r.ok ? 'ok' : 'fail'} />
      <div className="stack-xs" style={{ minWidth: 0, flex: 1 }}>
        <span>
          <strong>{r.ok ? 'Test passed.' : 'Test failed.'}</strong> {r.text}
        </span>
        {r.detail && (
          <details className="disclosure">
            <summary>
              <Icon name="chevron" /> Details
            </summary>
            <pre className="disclosure-body mono" style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 200, overflow: 'auto' }}>
              {r.detail}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

function IntegrationCard(props: {
  icon: string;
  name: string;
  role: string;
  health: Health;
  healthLabel: string;
  whenOff: string;
  env: Array<{ name: string; set: boolean | null; note?: string }>;
  test?: { label: string; run: () => Promise<any>; summarize: (r: any) => string; disabledReason?: string };
  troubleshooting: string[];
  children?: ReactNode;
}) {
  const t = useTest(props.test?.run ?? (async () => null), props.test?.summarize ?? (() => ''));
  const health: Health = t.result ? (t.result.ok ? 'ok' : 'error') : props.health;
  const label = t.result ? (t.result.ok ? 'Connected' : 'Failing') : props.healthLabel;
  return (
    <section className="card int-card" aria-labelledby={`int-${props.icon}`}>
      <div className="card-body">
        <div className="int-head">
          <span className="int-logo">
            <Icon name={props.icon} />
          </span>
          <div className="stack-xs" style={{ flex: 1, minWidth: 0 }}>
            <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <h2 id={`int-${props.icon}`}>{props.name}</h2>
              <Badge tone={HEALTH[health].tone} icon={HEALTH[health].icon}>
                {label}
              </Badge>
            </div>
            <p className="small muted">{props.role}</p>
          </div>
        </div>
        {props.health !== 'ok' && !t.result?.ok && (
          <Callout icon="info" tone={props.health === 'error' ? 'tone-fail' : ''}>
            <span>
              <strong>{props.health === 'error' ? 'Configured, but failing.' : 'Not active.'}</strong> {props.whenOff}
            </span>
          </Callout>
        )}
        <div className="stack-xs">
          <span className="eyebrow">Configuration</span>
          <ul className="env-list">
            {props.env.map((e) => (
              <li key={e.name}>
                <Icon name={e.set === null ? 'info' : e.set ? 'ok' : 'skip'} className="" />
                <code>{e.name}</code>
                <span className="xs muted">{e.set === null ? e.note : e.set ? 'set' : 'not set'}</span>
                {e.set !== null && e.note && <span className="xs faint">· {e.note}</span>}
              </li>
            ))}
          </ul>
          <span className="xs faint">Set in the server environment (.env). Values are never sent to the browser.</span>
        </div>
        {props.children}
        <div className="int-foot stack-sm">
        {props.test && (
          <div className="stack-sm">
            <div className="row-wrap">
              <button className="btn btn-sm" onClick={t.go} disabled={t.busy || Boolean(props.test.disabledReason)} aria-busy={t.busy} title={props.test.disabledReason}>
                <Icon name={t.busy ? 'loader' : 'play'} className={t.busy ? 'spin' : undefined} />
                {t.busy ? 'Testing…' : props.test.label}
              </button>
              {props.test.disabledReason && <span className="xs faint">{props.test.disabledReason}</span>}
              {t.result && (
                <span className="xs faint">
                  checked <TimeAgo iso={t.result.at} />
                </span>
              )}
            </div>
            {t.result && <TestResult r={t.result} />}
          </div>
        )}
        <details className="disclosure">
          <summary>
            <Icon name="chevron" /> Troubleshooting
          </summary>
          <ul className="basis disclosure-body">
            {props.troubleshooting.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
        </div>
      </div>
    </section>
  );
}

function ModelsResolved({ s }: { s: Status }) {
  const m = s.nebius.models;
  if (!s.nebius.configured || !m || 'error' in m) return null;
  return (
    <div className="stack-xs">
      <span className="eyebrow">Resolved from the live catalog</span>
      <dl className="kv">
        <dt>Triage</dt>
        <dd className="mono">{m.triage ?? 'none available'}</dd>
        <dt>Reasoning</dt>
        <dd className="mono">{m.reasoning ?? 'none available'}</dd>
        <dt>Patches</dt>
        <dd className="mono">{m.deep ?? 'none available'}</dd>
      </dl>
      {m.notes.map((n) => (
        <Callout key={n} tone="tone-warn" icon="assumption">
          <span>{n}</span>
        </Callout>
      ))}
    </div>
  );
}

function InvestigateRun({ s }: { s: Status }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const valid = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+/.test(url.trim());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) {
      setErr('Paste a run URL like https://github.com/owner/repo/actions/runs/123456789');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const inv = await api.startGitHub(url.trim(), 'auto');
      toast(inv.duplicate ? 'This run was already investigated. Opening it.' : 'Investigation started.');
      navigate(`/investigations/${inv.id}`);
    } catch (e2) {
      const hint = (e2 as { hint?: string }).hint;
      setErr(`${(e2 as Error).message}${hint ? ` ${hint}` : ''}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="stack-sm" noValidate>
      <label className="field">
        Investigate a failed run
        <input
          className="input"
          type="url"
          placeholder="https://github.com/owner/repo/actions/runs/123456789"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setErr(null);
          }}
          disabled={!s.github.configured}
          aria-invalid={Boolean(err)}
          aria-describedby="run-url-help"
        />
        {err ? (
          <span className="field-error" id="run-url-help" role="alert">
            {err}
          </span>
        ) : (
          <span className="field-help" id="run-url-help">
            {s.github.configured ? 'Sandbox experiments clone public repositories at the failing commit. Jest, Maven, and pytest (requirements.txt layout) are supported.' : 'Requires GITHUB_TOKEN on the server.'}
          </span>
        )}
      </label>
      <div>
        <button className="btn btn-primary btn-sm" disabled={!s.github.configured || busy || !url} aria-busy={busy}>
          <Icon name={busy ? 'loader' : 'search'} className={busy ? 'spin' : undefined} /> {busy ? 'Fetching run…' : 'Investigate run'}
        </button>
      </div>
    </form>
  );
}

function Repositories({ readOnly }: { readOnly: boolean }) {
  const { data, reload } = useApi(() => api.repositories(), []);
  const [name, setName] = useState('');
  const toast = useToast();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.addRepository(name.trim());
      setName('');
      reload();
      toast('Repository added.');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  return (
    <div className="stack-sm">
      <h3>Tracked repositories</h3>
      {data?.length ? (
        <ul className="env-list">
          {data.map((r) => (
            <li key={r.fullName}>
              <Icon name="github" className="" />
              <a href={String(r.data.url ?? `https://github.com/${r.fullName}`)} target="_blank" rel="noreferrer">
                {r.fullName}
              </a>
              <span className="xs faint">
                added <TimeAgo iso={r.addedAt} />
              </span>
              <span className="spacer" />
              {!readOnly && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    await api.removeRepository(r.fullName);
                    reload();
                  }}
                  aria-label={`Remove ${r.fullName}`}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">None yet. Repositories are added when a webhook arrives or a run is investigated.</p>
      )}
      {!readOnly && (
        <form className="row" onSubmit={add}>
          <input className="input" placeholder="owner/repo" value={name} onChange={(e) => setName(e.target.value)} pattern="[\w.\-]+/[\w.\-]+" aria-label="Repository full name" style={{ flex: 1 }} />
          <button className="btn btn-sm" disabled={!name}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}

export function Integrations() {
  const { data: s, error, loading, reload } = useApi(() => api.status(), []);
  const deliveries = useApi(() => api.deliveries(), []);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !s) return <Loading rows={6} label="Loading integrations" />;
  const webhookUrl = `${window.location.origin}/api/webhooks/github`;
  const nebiusErr = s.nebius.configured && s.nebius.models && 'error' in s.nebius.models ? (s.nebius.models as { error: string }).error : null;

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Integrations</h1>
          <p className="lead">Status comes from live backend checks. Credentials stay in server environment variables and are never shown here.</p>
        </div>
        <button className="btn" onClick={reload}>
          <Icon name="refresh" /> Re-check
        </button>
      </div>

      <div className="int-grid">
        <IntegrationCard
          icon="spark"
          name="NVIDIA Nemotron · Nebius Token Factory"
          role="Reads CI logs, proposes competing hypotheses, weighs experiment evidence, and writes candidate fixes. Model IDs are resolved from your account's live /v1/models catalog."
          health={!s.nebius.configured ? 'unconfigured' : nebiusErr ? 'error' : 'ok'}
          healthLabel={!s.nebius.configured ? 'Not configured' : nebiusErr ? 'Failing' : 'Connected'}
          whenOff={nebiusErr ? `Catalog request failed: ${nebiusErr}` : 'Model stages fall back to recorded replays (demo scenarios) or labeled heuristic rules. Experiments still run.'}
          env={[
            { name: 'NEBIUS_API_KEY', set: s.nebius.configured },
            { name: 'NEBIUS_BASE_URL', set: null, note: s.nebius.baseUrl },
            { name: 'ALIBI_MODEL_TRIAGE / _REASONING / _DEEP', set: null, note: 'optional overrides' },
          ]}
          test={{
            label: 'Send a test inference',
            run: api.testNebius,
            summarize: (r) => (r?.ok ? `${r.model} answered in ${r.latencyMs} ms.` : r?.error ?? 'No Nemotron model available.'),
            disabledReason: s.nebius.configured ? undefined : 'Add NEBIUS_API_KEY first',
          }}
          troubleshooting={[
            'The app reads only the repository-root .env file, not .env.example. Restart the server after editing it.',
            '401: the key is invalid or revoked. Create a new key in Token Factory → API keys.',
            'No Nemotron model found: check that your account and region list Nemotron models, or set NEBIUS_BASE_URL to the region URL shown in your dashboard.',
            'Per-call errors are recorded in each investigation’s Model calls tab.',
          ]}
        >
          <ModelsResolved s={s} />
        </IntegrationCard>

        <IntegrationCard
          icon="box"
          name="Sandbox runner"
          role="Executes experiments: reproduce, repeat, parent comparison, and fix validation, each in a throwaway Docker container."
          health={s.runner.ok ? 'ok' : 'error'}
          healthLabel={s.runner.ok ? 'Ready' : 'Unavailable'}
          whenOff={`Docker check failed: ${s.runner.detail}. Investigations still analyse logs and diffs, but every experiment is marked skipped and verdicts stay inconclusive.`}
          env={[
            { name: 'ALIBI_RUNNER', set: null, note: s.runner.backend },
            { name: 'ALIBI_NODE_IMAGE', set: null, note: s.runner.nodeImage },
            { name: 'ALIBI_MAVEN_IMAGE', set: null, note: s.runner.mavenImage },
            { name: 'ALIBI_RUNNER_CPUS / _MEMORY', set: null, note: `${s.runner.cpus} CPU · ${s.runner.memory}` },
          ]}
          test={{ label: 'Check Docker', run: api.testRunner, summarize: (r) => r?.detail ?? '' }}
          troubleshooting={[
            `Start Docker Desktop, Rancher Desktop, or Docker Engine, and confirm \`docker version\` works for the user running ${BRAND.name}.`,
            'Pre-pull the runner images to avoid a slow first investigation.',
            'Containers run as uid 1000 with no capabilities, a read-only root, and no network during tests. Only the workspace is mounted.',
          ]}
        />

        <IntegrationCard
          icon="globe"
          name="Tavily search"
          role="When a hypothesis implicates a dependency or external service, searches release notes, issues, and status pages, and records each result as a lead in the ledger."
          health={s.tavily.configured ? 'configured' : 'unconfigured'}
          healthLabel={s.tavily.configured ? 'Configured · untested' : 'Not configured'}
          whenOff="The external-search experiment is skipped and labeled. Nothing else is affected."
          env={[{ name: 'TAVILY_API_KEY', set: s.tavily.configured }]}
          test={{
            label: 'Run a test search',
            run: api.testTavily,
            summarize: (r) => `${r?.results?.length ?? 0} results in ${r?.responseTimeSec ?? '?'} s.`,
            disabledReason: s.tavily.configured ? undefined : 'Add TAVILY_API_KEY first',
          }}
          troubleshooting={['401: the key is invalid.', '432/433: plan or usage limit reached.', `Results are leads only; ${BRAND.name} never treats a search result as proof.`]}
        />

        <IntegrationCard
          icon="github"
          name="GitHub Actions"
          role="Fetches failed runs, job logs, commit diffs, and PR associations; receives workflow_run webhooks; opens draft PRs for validated fixes."
          health={s.github.configured ? 'configured' : 'unconfigured'}
          healthLabel={s.github.configured ? 'Configured · untested' : 'Not configured'}
          whenOff="Only demo scenarios can be investigated. Webhooks are rejected without GITHUB_WEBHOOK_SECRET."
          env={[
            { name: 'GITHUB_TOKEN', set: s.github.configured, note: 'Actions, Contents, Metadata: read' },
            { name: 'GITHUB_WEBHOOK_SECRET', set: s.github.webhookSecret },
          ]}
          test={{
            label: 'Test token',
            run: api.testGitHub,
            summarize: (r) => `Authenticated as ${r?.login}${r?.scopes ? ` (scopes: ${r.scopes})` : ''}.`,
            disabledReason: s.github.configured ? undefined : 'Add GITHUB_TOKEN first',
          }}
          troubleshooting={[
            '403: the token lacks Actions: read or Contents: read, or the rate limit was hit.',
            'Draft PRs additionally need Contents: write and Pull requests: write.',
            'A run that "failed but has no jobs" never started (workflow error or fork PR awaiting approval).',
          ]}
        >
          <InvestigateRun s={s} />
        </IntegrationCard>
      </div>

      <section className="card" aria-labelledby="webhook-title">
        <div className="card-head">
          <h2 id="webhook-title">
            <Icon name="link" /> Webhooks and repositories
          </h2>
          <Badge tone={s.github.webhookSecret ? 'tone-pass' : 'tone-neutral'} icon={s.github.webhookSecret ? 'ok' : 'skip'}>
            {s.github.webhookSecret ? 'Secret configured' : 'Secret not set'}
          </Badge>
        </div>
        <div className="card-body grid cols-2" style={{ gap: 24 }}>
          <div className="stack-sm">
            <h3>Repository webhook</h3>
            <dl className="kv">
              <dt>Payload URL</dt>
              <dd className="row" style={{ gap: 6 }}>
                <span className="mono wrap-any">{webhookUrl}</span>
                <CopyButton text={webhookUrl} label="" className="btn btn-ghost btn-sm btn-icon" />
              </dd>
              <dt>Content type</dt>
              <dd className="mono">application/json</dd>
              <dt>Events</dt>
              <dd>Workflow runs</dd>
              <dt>Auto-investigate</dt>
              <dd>
                {s.github.autoInvestigate ? 'On' : 'Off'} · <Link to="/settings">change</Link>
              </dd>
            </dl>
            <p className="xs faint">Signatures (X-Hub-Signature-256) are verified in constant time. Duplicate deliveries and repeated runs are ignored.</p>
          </div>
          <Repositories readOnly={s.publicDemo} />
        </div>
        <div className="card-foot" style={{ padding: 0, background: 'var(--surface)' }}>
          <div className="row" style={{ padding: '12px 20px' }}>
            <h3>Recent deliveries</h3>
            <span className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={deliveries.reload}>
              <Icon name="refresh" /> Refresh
            </button>
          </div>
          {deliveries.data?.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Delivery</th>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Received</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.data.map((d) => (
                    <tr key={d.deliveryId}>
                      <td className="mono">{d.deliveryId.slice(0, 12)}</td>
                      <td>{d.event}</td>
                      <td>
                        <Badge tone={d.status === 'investigating' ? 'tone-info' : d.status === 'error' ? 'tone-fail' : 'tone-neutral'}>{d.status}</Badge>
                      </td>
                      <td className="muted">
                        <TimeAgo iso={d.receivedAt} />
                      </td>
                      <td>{d.investigationId ? <Link to={`/investigations/${d.investigationId}`}>Open investigation</Link> : <span className="muted">{d.detail}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No deliveries received" icon="link">
              <p>Add the webhook above to a GitHub repository to record failed runs here.</p>
            </Empty>
          )}
        </div>
      </section>
    </div>
  );
}
