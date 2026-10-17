import { useEffect, useState } from 'react';
import { api, type Settings } from '../api';
import { Callout, ErrorBox, Icon, Loading, useToast } from '../components/ui';
import { BRAND } from '../brand';
import { useApi } from '../hooks';

type Form = Pick<Settings, 'repeatDefault' | 'defaultMode' | 'autoInvestigate'>;

export function SettingsPage() {
  const { data, error, loading, reload } = useApi(() => api.settings(), []);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (data) setForm({ repeatDefault: data.repeatDefault, defaultMode: data.defaultMode, autoInvestigate: data.autoInvestigate });
  }, [data]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !data || !form) return <Loading rows={5} label="Loading settings" />;
  const dirty = form.repeatDefault !== data.repeatDefault || form.defaultMode !== data.defaultMode || form.autoInvestigate !== data.autoInvestigate;
  const repeatInvalid = !Number.isInteger(form.repeatDefault) || form.repeatDefault < 2 || form.repeatDefault > 30;

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings(form);
      toast('Settings saved.');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Settings</h1>
          <p className="lead">Non-secret defaults stored in {BRAND.name}'s database. API keys are configured only through server environment variables.</p>
        </div>
      </div>
      {data.readOnly && (
        <Callout tone="tone-warn" icon="shield">
          <span>This is the public demo. Settings are read-only.</span>
        </Callout>
      )}
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!repeatInvalid) save();
        }}
      >
        <div className="card-head">
          <h2>Investigation defaults</h2>
        </div>
        <div className="card-body stack-md">
          <label className="field">
            Repeated runs per flake experiment
            <input
              className="input"
              type="number"
              min={2}
              max={30}
              value={Number.isNaN(form.repeatDefault) ? '' : form.repeatDefault}
              disabled={data.readOnly}
              onChange={(e) => setForm({ ...form, repeatDefault: e.target.valueAsNumber })}
              style={{ maxWidth: 120 }}
              aria-invalid={repeatInvalid}
              aria-describedby="repeat-help"
            />
            {repeatInvalid ? (
              <span className="field-error" id="repeat-help" role="alert">
                Enter a whole number from 2 to 30.
              </span>
            ) : (
              <span className="field-help" id="repeat-help">
                Default 10. More runs narrow the confidence interval on the observed failure rate but take longer.
              </span>
            )}
          </label>
          <label className="field">
            Default reasoning mode
            <select className="select" value={form.defaultMode} disabled={data.readOnly} onChange={(e) => setForm({ ...form, defaultMode: e.target.value as Settings['defaultMode'] })} style={{ maxWidth: 360 }}>
              <option value="auto">Auto: live Nemotron when configured</option>
              <option value="live">Live Nemotron only</option>
              <option value="replay">Replay recorded outputs (demo scenarios)</option>
              <option value="heuristic">Heuristic rules (no model)</option>
            </select>
            <span className="field-help">Applies to new investigations. Each investigation shows the mode it actually used.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.autoInvestigate} disabled={data.readOnly} onChange={(e) => setForm({ ...form, autoInvestigate: e.target.checked })} />
            <span className="stack-xs">
              <span className="strong">Investigate failed runs automatically</span>
              <span className="field-help">When a signed workflow_run webhook reports a failure, start an investigation without waiting for a click.</span>
            </span>
          </label>
        </div>
        <div className="card-foot row">
          <button type="submit" className="btn btn-primary" disabled={!dirty || saving || data.readOnly || repeatInvalid} aria-busy={saving}>
            <Icon name={saved ? 'check' : saving ? 'loader' : 'check'} className={saving ? 'spin' : undefined} />
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save settings'}
          </button>
          {dirty && (
            <button type="button" className="btn btn-ghost" onClick={() => setForm({ repeatDefault: data.repeatDefault, defaultMode: data.defaultMode, autoInvestigate: data.autoInvestigate })}>
              Discard changes
            </button>
          )}
        </div>
      </form>
      <section className="card">
        <div className="card-head">
          <h2>Environment</h2>
          <span className="small faint">Read-only · change in .env and restart</span>
        </div>
        <div className="card-body">
          <dl className="kv">
            <dt>Model overrides</dt>
            <dd className="mono">
              {Object.entries(data.env.modelOverrides)
                .filter(([, v]) => v)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ') || 'none (resolved from the live catalog)'}
            </dd>
            <dt>Model call budget</dt>
            <dd>{data.env.maxModelCalls} calls per investigation</dd>
            <dt>Log context budget</dt>
            <dd>{data.env.maxLogChars.toLocaleString()} characters</dd>
            <dt>Runner timeout</dt>
            <dd>{data.env.runnerTimeoutSec} s per test run</dd>
          </dl>
        </div>
      </section>
    </div>
  );
}
