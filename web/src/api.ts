import type {
  EvidenceRecord,
  Experiment,
  ExternalSource,
  Hypothesis,
  Investigation,
  ModelCall,
  Patch,
} from '../../server/src/domain/types';

export type * from '../../server/src/domain/types';

export interface Bundle {
  investigation: Investigation;
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  evidence: EvidenceRecord[];
  sources: ExternalSource[];
  patches: Patch[];
  modelCalls: ModelCall[];
  queuePosition: number;
}

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  repository: string;
  framework: 'jest' | 'maven' | 'pytest';
  job: string;
  replayRecordedAt: string | null;
  expected?: { experiments: string[] };
}

export interface Overview {
  totals: { investigations: number; experiments: number; executedRuns: number; validatedFixes: number; patchesTotal: number };
  byClassification: Record<string, number>;
  byVerdict: Record<string, number>;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  recent: Investigation[];
  repositories: Array<{ repository: string; investigations: number; lastAt: string; source: string }>;
}

export interface Status {
  publicDemo: boolean;
  nebius: {
    configured: boolean;
    baseUrl: string;
    models: null | { error: string } | { triage: string | null; reasoning: string | null; deep: string | null; nemotronAvailable: string[]; notes: string[] };
  };
  tavily: { configured: boolean };
  github: { configured: boolean; webhookSecret: boolean; autoInvestigate: boolean };
  runner: { backend: string; ok: boolean; detail: string; nodeImage: string; mavenImage: string; cpus: string; memory: string };
  replays: Record<string, string | null>;
  queue: number;
}

export interface Settings {
  repeatDefault: number;
  defaultMode: 'auto' | 'live' | 'replay' | 'heuristic';
  autoInvestigate: boolean;
  readOnly: boolean;
  env: { modelOverrides: Record<string, string | undefined>; maxModelCalls: number; maxLogChars: number; runnerTimeoutSec: number };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly hint?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, body?.hint);
  return body as T;
}

export const api = {
  status: () => request<Status>('/api/status'),
  overview: () => request<Overview>('/api/overview'),
  scenarios: () => request<Scenario[]>('/api/scenarios'),
  investigations: (params: Record<string, string>) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return request<Investigation[]>(`/api/investigations${q.size ? `?${q}` : ''}`);
  },
  investigation: (id: string) => request<Bundle>(`/api/investigations/${encodeURIComponent(id)}`),
  log: (id: string, from?: number, to?: number) => {
    const q = new URLSearchParams();
    if (from) q.set('from', String(from));
    if (to) q.set('to', String(to));
    return request<{ totalLines: number; from: number; to: number; lines: string[] }>(`/api/investigations/${encodeURIComponent(id)}/log?${q}`);
  },
  startDemo: (scenarioId: string, mode: string, repeat?: number) =>
    request<Investigation>('/api/investigations/demo', { method: 'POST', body: JSON.stringify({ scenarioId, mode, repeat }) }),
  startGitHub: (runUrl: string, mode: string) =>
    request<Investigation & { duplicate?: boolean }>('/api/investigations/github', { method: 'POST', body: JSON.stringify({ runUrl, mode }) }),
  /** Change verification: exactly one of investigationId, scenarioId, or repoUrl; base/head are commit SHAs. */
  startVerification: (body: { investigationId?: string; scenarioId?: string; repoUrl?: string; base?: string; head?: string; mode?: string }) =>
    request<Investigation>('/api/verifications', { method: 'POST', body: JSON.stringify(body) }),
  sampleRevisions: (scenarioId: string) => request<Array<{ sha: string; message: string }>>(`/api/scenarios/${encodeURIComponent(scenarioId)}/revisions`),
  rerun: (id: string) => request<Investigation>(`/api/investigations/${encodeURIComponent(id)}/rerun`, { method: 'POST', body: '{}' }),
  remove: (id: string) => request<void>(`/api/investigations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  validatePatch: (patchId: string) => request<Patch>(`/api/patches/${encodeURIComponent(patchId)}/validate`, { method: 'POST', body: '{}' }),
  createPr: (patchId: string) => request<{ url: string; branch: string }>(`/api/patches/${encodeURIComponent(patchId)}/pull-request`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  settings: () => request<Settings>('/api/settings'),
  saveSettings: (s: Partial<Settings>) => request<Record<string, unknown>>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
  repositories: () => request<Array<{ fullName: string; addedAt: string; data: Record<string, unknown> }>>('/api/repositories'),
  addRepository: (fullName: string) => request('/api/repositories', { method: 'POST', body: JSON.stringify({ fullName }) }),
  removeRepository: (fullName: string) => request(`/api/repositories/${fullName}`, { method: 'DELETE' }),
  deliveries: () => request<Array<{ deliveryId: string; event: string; receivedAt: string; status: string; investigationId: string | null; detail: string | null }>>('/api/webhooks/deliveries'),
  modelCalls: () => request<ModelCall[]>('/api/model-calls'),
  testNebius: () => request<any>('/api/integrations/nebius/test', { method: 'POST', body: '{}' }),
  testTavily: () => request<any>('/api/integrations/tavily/test', { method: 'POST', body: '{}' }),
  testGitHub: () => request<any>('/api/integrations/github/test', { method: 'POST', body: '{}' }),
  testRunner: () => request<{ ok: boolean; detail: string }>('/api/integrations/runner/test', { method: 'POST', body: '{}' }),
};
