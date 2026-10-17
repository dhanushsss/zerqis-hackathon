import type { Status } from './api';

export interface Readiness {
  key: 'nemotron' | 'sandbox' | 'tavily' | 'github';
  label: string;
  ok: boolean;
  /** Not configured · Configured · Live/Ready · Error/Unavailable — from backend checks only. */
  state: string;
  failing: boolean;
}

export function readiness(s: Status): Readiness[] {
  const nebiusError = Boolean(s.nebius.configured && s.nebius.models && 'error' in s.nebius.models);
  return [
    { key: 'nemotron', label: 'Nemotron', ok: s.nebius.configured && !nebiusError, failing: nebiusError, state: !s.nebius.configured ? 'Not configured' : nebiusError ? 'Error' : 'Live' },
    { key: 'sandbox', label: 'Sandbox', ok: s.runner.ok, failing: !s.runner.ok, state: s.runner.ok ? 'Ready' : 'Unavailable' },
    { key: 'tavily', label: 'Tavily', ok: s.tavily.configured, failing: false, state: s.tavily.configured ? 'Configured' : 'Not configured' },
    { key: 'github', label: 'GitHub', ok: s.github.configured, failing: false, state: s.github.configured ? 'Configured' : 'Not configured' },
  ];
}
