import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

export interface ContainerSpec {
  image: string;
  /** argv executed inside the container — never passed through a shell. */
  command: string[];
  workspace: string;
  /** Optional cache directory mounted at /cache (dependency caches only). */
  cacheDir?: string;
  network: boolean;
  env?: Record<string, string>;
  timeoutSec: number;
  maxOutputBytes?: number;
}

export interface ContainerResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  outputTruncated: boolean;
  containerName: string;
  dockerArgs: string[];
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Builds `docker run` arguments for an untrusted workload. The workload runs
 * as uid 1000 with all capabilities dropped, no privilege escalation, a
 * read-only root filesystem, bounded CPU/memory/pids, and (by default) no
 * network. Only the workspace (and optionally a dependency cache) is mounted.
 * The host Docker socket and host environment are never passed through.
 */
export function buildDockerArgs(spec: ContainerSpec, name: string): string[] {
  const args = [
    'run', '--rm', '--name', name,
    '--network', spec.network ? 'bridge' : 'none',
    '--user', '1000:1000',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512',
    '--memory', config.runner.memory,
    '--memory-swap', config.runner.memory,
    '--cpus', config.runner.cpus,
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,size=768m',
    '-e', 'HOME=/tmp',
    '-e', 'CI=true',
    '-v', `${spec.workspace}:/work:rw`,
    '-w', '/work',
  ];
  if (spec.cacheDir) args.push('-v', `${spec.cacheDir}:/cache:rw`);
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!ENV_KEY.test(k)) throw new Error(`Refusing invalid env key ${k}`);
    args.push('-e', `${k}=${v}`);
  }
  args.push(spec.image, ...spec.command);
  return args;
}

export async function runContainer(spec: ContainerSpec): Promise<ContainerResult> {
  const name = `alibi-exp-${randomBytes(6).toString('hex')}`;
  const dockerArgs = buildDockerArgs(spec, name);
  const limit = spec.maxOutputBytes ?? config.runner.maxOutputBytes;
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn('docker', dockerArgs, {
      env: dockerCliEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const collect = (buf: Buffer) => {
      if (size >= limit) {
        truncated = true;
        return;
      }
      const room = limit - size;
      chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
      size += Math.min(buf.length, room);
      if (buf.length > room) truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn('docker', ['kill', name], { env: dockerCliEnv(), stdio: 'ignore' });
    }, spec.timeoutSec * 1000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        durationMs: Date.now() - started,
        output: Buffer.concat(chunks).toString('utf8'),
        outputTruncated: truncated,
        containerName: name,
        dockerArgs,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        output: `Failed to start docker: ${err.message}`,
        outputTruncated: false,
        containerName: name,
        dockerArgs,
      });
    });
  });
}

/** Only what the docker CLI needs to reach the daemon; no app secrets. */
function dockerCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' };
  for (const k of ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

let dockerStatus: { ok: boolean; detail: string; checkedAt: number } | null = null;

export async function checkDocker(force = false): Promise<{ ok: boolean; detail: string }> {
  if (config.runner.backend === 'disabled') return { ok: false, detail: 'Runner disabled by ALIBI_RUNNER=disabled' };
  if (!force && dockerStatus && Date.now() - dockerStatus.checkedAt < 60_000) return dockerStatus;
  const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], { env: dockerCliEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true, detail: `Docker Engine ${out.trim()}` } : { ok: false, detail: out.trim() || 'docker unavailable' }),
    );
    child.on('error', (e) => resolve({ ok: false, detail: e.message }));
  });
  dockerStatus = { ...result, checkedAt: Date.now() };
  return result;
}
