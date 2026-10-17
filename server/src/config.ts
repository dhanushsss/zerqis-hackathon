import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root (server/src or server/dist are both two levels down). */
export const ROOT_DIR = resolve(here, '..', '..');

const envFile = resolve(ROOT_DIR, '.env');
if (existsSync(envFile)) loadDotenv({ path: envFile });

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  publicBaseUrl?: string;
  nebius: {
    apiKey?: string;
    baseUrl: string;
    projectId?: string;
    timeoutMs: number;
    maxRetries: number;
    models: { triage?: string; reasoning?: string; deep?: string };
    maxCallsPerInvestigation: number;
    maxInputChars: number;
  };
  tavily: { apiKey?: string; timeoutMs: number };
  github: { token?: string; webhookSecret?: string; apiUrl: string; autoInvestigate: boolean };
  runner: {
    backend: 'docker' | 'disabled';
    nodeImage: string;
    mavenImage: string;
    pythonImage: string;
    goImage: string;
    cpus: string;
    memory: string;
    timeoutSec: number;
    installTimeoutSec: number;
    maxOutputBytes: number;
    repeatDefault: number;
  };
  demoReadOnly: boolean;
  /** Bounded model-driven loop. Off unless ALIBI_LOOP=1; single-pass behaviour is unchanged when off. */
  agentLoop: {
    enabled: boolean;
    maxIterations: number;
    maxModelCalls: number;
    maxTokens: number;
    maxMs: number;
    maxRuns: number;
    maxRunsPerAction: number;
    maxSearches: number;
  };
  /** Proxies trusted to set X-Forwarded-For (false = none; the socket address is the client). */
  trustProxy: false | string | number;
}

export function loadConfig(): AppConfig {
  const dataDir = resolve(ROOT_DIR, str('ALIBI_DATA_DIR') ?? 'data');
  return {
    port: int('PORT', 8787),
    host: str('HOST') ?? '127.0.0.1',
    dataDir,
    publicBaseUrl: str('ALIBI_PUBLIC_URL'),
    nebius: {
      apiKey: str('NEBIUS_API_KEY'),
      baseUrl: (str('NEBIUS_BASE_URL') ?? 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, ''),
      projectId: str('NEBIUS_PROJECT_ID'),
      timeoutMs: int('NEBIUS_TIMEOUT_MS', 120_000),
      maxRetries: int('NEBIUS_MAX_RETRIES', 3),
      models: {
        triage: str('ALIBI_MODEL_TRIAGE'),
        reasoning: str('ALIBI_MODEL_REASONING'),
        deep: str('ALIBI_MODEL_DEEP'),
      },
      maxCallsPerInvestigation: int('ALIBI_MAX_MODEL_CALLS', 8),
      maxInputChars: int('ALIBI_MAX_LOG_CHARS', 120_000),
    },
    tavily: { apiKey: str('TAVILY_API_KEY'), timeoutMs: int('TAVILY_TIMEOUT_MS', 20_000) },
    github: {
      token: str('GITHUB_TOKEN'),
      webhookSecret: str('GITHUB_WEBHOOK_SECRET'),
      apiUrl: (str('GITHUB_API_URL') ?? 'https://api.github.com').replace(/\/+$/, ''),
      autoInvestigate: str('ALIBI_AUTO_INVESTIGATE') === 'true',
    },
    runner: {
      backend: str('ALIBI_RUNNER') === 'disabled' ? 'disabled' : 'docker',
      nodeImage: str('ALIBI_NODE_IMAGE') ?? 'node:20-bookworm-slim',
      mavenImage: str('ALIBI_MAVEN_IMAGE') ?? 'maven:3.9-eclipse-temurin-17',
      // Pinned by digest: dependency installation and test runs use exactly this interpreter.
      pythonImage: str('ALIBI_PYTHON_IMAGE') ?? 'python:3.12.7-slim-bookworm@sha256:60d9996b6a8a3689d36db740b49f4327be3be09a21122bd02fb8895abb38b50d',
      goImage: str('ALIBI_GO_IMAGE') ?? 'golang:1.24.9-bookworm@sha256:737b40b61ce956d738bed59f18ba854d8d67e7a4c4fa63f64437f4c70247ac5b',
      cpus: str('ALIBI_RUNNER_CPUS') ?? '1.5',
      memory: str('ALIBI_RUNNER_MEMORY') ?? '1536m',
      timeoutSec: int('ALIBI_RUNNER_TIMEOUT_SEC', 180),
      installTimeoutSec: int('ALIBI_RUNNER_INSTALL_TIMEOUT_SEC', 420),
      maxOutputBytes: int('ALIBI_RUNNER_MAX_OUTPUT_BYTES', 512 * 1024),
      repeatDefault: int('ALIBI_REPEAT_DEFAULT', 10),
    },
    demoReadOnly: str('ALIBI_DEMO_READONLY') === 'true',
    agentLoop: {
      enabled: str('ALIBI_LOOP') === '1' || str('ALIBI_LOOP') === 'true',
      maxIterations: bounded('ALIBI_LOOP_MAX_ITERATIONS', 4, 4),
      maxModelCalls: bounded('ALIBI_LOOP_MAX_MODEL_CALLS', 4, 4),
      maxTokens: bounded('ALIBI_LOOP_MAX_TOKENS', 40_000, 500_000),
      maxMs: bounded('ALIBI_LOOP_MAX_MS', 8 * 60_000, 60 * 60_000),
      maxRuns: bounded('ALIBI_LOOP_MAX_RUNS', 30, 200),
      maxRunsPerAction: bounded('ALIBI_LOOP_MAX_RUNS_PER_ACTION', 10, 20),
      maxSearches: bounded('ALIBI_LOOP_MAX_SEARCHES', 2, 3),
    },
    trustProxy: trustProxySetting(str('ALIBI_TRUST_PROXY')),
  };
}

/**
 * Non-negative integer limit with a hard maximum. Negative or non-numeric values fall back to
 * the default (0 stays allowed: it disables that resource); values above the cap are clamped.
 */
function bounded(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  return Math.min(Number.parseInt(raw, 10), max);
}

/**
 * Which proxies may set X-Forwarded-For. Off by default: a direct client cannot choose its own
 * address. Set ALIBI_TRUST_PROXY to the proxy's address(es)/CIDR(s), e.g. "127.0.0.1" when Caddy
 * runs on the same host, or to a hop count. "true" (trust any hop) is refused because it lets
 * clients spoof their address.
 */
export function trustProxySetting(raw: string | undefined): false | string | number {
  if (!raw || /^(false|0|off|no)$/i.test(raw)) return false;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^(true|yes|on)$/i.test(raw)) return false;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$|^(loopback|linklocal|uniquelocal)$/.test(s))
    .join(',') || false;
}

export const config = loadConfig();
