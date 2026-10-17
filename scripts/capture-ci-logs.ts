/**
 * Captures each scenario's CI log by actually running its CI command on the
 * failing commit inside the Alibi sandbox, then wrapping the real output in
 * GitHub Actions log format (timestamps, step groups, final ##[error] line).
 *
 * The output is a fixture: it is what the investigation starts from in demo
 * mode. Every test result inside it came from a real execution.
 *
 *   npm run demo:capture-logs [scenarioId]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../server/src/config.js';
import { runContainer } from '../server/src/runner/docker.js';
import { envFor, imageFor } from '../server/src/runner/frameworks.js';
import { checkout, prepareWorkspace } from '../server/src/runner/workspace.js';
import { buildDemoRepo } from '../server/src/scenarios/build.js';
import { getScenario, listScenarios, scenarioLogPath } from '../server/src/scenarios/registry.js';

/** Seed recorded for the flaky scenario's CI run (Jest prints it via --showSeed). */
const FLAKY_CI_SEED = 1849273600;

function ghaLines(start: Date, lines: string[], stepMs = 37): string[] {
  let t = start.getTime();
  return lines.map((l) => {
    t += stepMs;
    return `${new Date(t).toISOString().replace('Z', '0000Z')} ${l}`;
  });
}

const only = process.argv[2];
for (const s of listScenarios().filter((x) => !only || x.id === only)) {
  const scenario = getScenario(s.id)!;
  const repo = await buildDemoRepo(s.id);
  const failing = repo.commits[repo.commits.length - 1];
  const dir = join(config.dataDir, 'workspaces', `capture-${s.id}`);
  const cacheKey = `capture:${s.id}:${Date.now()}`;
  const started = new Date(new Date(scenario.commits[scenario.commits.length - 1].date).getTime() + 95_000);

  let installOut = '';
  let testCmd: string[];
  let network = false;
  let cacheDir: string | undefined;
  let displayCmd: string;
  if (scenario.framework === 'maven') {
    // Fresh cache + network so the log shows real dependency downloads; compile-only failure.
    await checkout({ location: repo.repoPath, cacheKey }, failing.sha, dir);
    cacheDir = join(config.dataDir, 'cache', `capture-${s.id}-${Date.now()}`);
    mkdirSync(cacheDir, { recursive: true });
    network = true;
    testCmd = ['mvn', '-B', '-Dmaven.repo.local=/cache/m2', 'test'];
    displayCmd = 'mvn -B test';
  } else {
    const ws = await prepareWorkspace({ location: repo.repoPath, cacheKey }, failing.sha, dir, scenario.framework);
    installOut = ws.install.map((i) => i.output).join('\n');
    cacheDir = ws.cacheDir;
    testCmd = scenario.id === 'flaky-jest' ? ['npm', 'test', '--', `--seed=${FLAKY_CI_SEED}`] : ['npm', 'test'];
    displayCmd = 'npm test';
  }

  const res = await runContainer({
    image: imageFor(scenario.framework),
    command: testCmd,
    workspace: dir,
    cacheDir,
    network,
    env: { ...envFor(scenario.framework), npm_config_cache: '/tmp/npm' },
    timeoutSec: 600,
    maxOutputBytes: 4 * 1024 * 1024,
  });

  const runner = scenario.framework === 'maven' ? 'Set up JDK 17 (temurin)' : 'Set up Node.js 20';
  const body: string[] = [
    'Current runner version: \'2.329.0\'',
    'Operating System',
    '  Ubuntu',
    '  24.04.3',
    'Runner Image',
    '  Image: ubuntu-24.04',
    `##[group]Run actions/checkout@v4`,
    'with:',
    `  repository: ${scenario.repository}`,
    '  token: ***',
    '##[endgroup]',
    `Syncing repository: ${scenario.repository}`,
    `HEAD is now at ${failing.sha.slice(0, 7)} ${failing.message}`,
    `##[group]Run ${scenario.framework === 'maven' ? 'actions/setup-java@v4' : 'actions/setup-node@v4'}`,
    runner,
    '##[endgroup]',
  ];
  if (scenario.framework !== 'maven') {
    body.push('##[group]Run npm ci', 'npm ci', '##[endgroup]', ...installOut.trim().split('\n'));
  }
  body.push(`##[group]Run ${displayCmd}`, displayCmd, '##[endgroup]', ...res.output.trimEnd().split('\n'));
  if (res.exitCode !== 0) body.push(`##[error]Process completed with exit code ${res.exitCode ?? 1}.`);

  const log = ghaLines(started, body).join('\n') + '\n';
  writeFileSync(scenarioLogPath(s.id), log);
  console.log(`${s.id}: exit=${res.exitCode} lines=${body.length} -> ${scenarioLogPath(s.id)}`);
}
