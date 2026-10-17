/** Manual probe: prepares each demo workspace and runs the full suite once. */
import { join } from 'node:path';
import { config } from '../server/src/config.js';
import { buildDemoRepo } from '../server/src/scenarios/build.js';
import { prepareWorkspace } from '../server/src/runner/workspace.js';
import { runContainer } from '../server/src/runner/docker.js';
import { envFor, imageFor, parseJestResult, parseSurefireReports, testCommand } from '../server/src/runner/frameworks.js';
import { getScenario } from '../server/src/scenarios/registry.js';

const id = process.argv[2] ?? 'flaky-jest';
const commitIdx = Number(process.argv[3] ?? 1);
const seeds = process.argv[4] ? process.argv[4].split(',').map(Number) : [undefined];
const s = getScenario(id)!;
const repo = await buildDemoRepo(id);
const sha = repo.commits[commitIdx].sha;
const dir = join(config.dataDir, 'workspaces', `probe-${id}-${commitIdx}`);
const t0 = Date.now();
const ws = await prepareWorkspace({ location: repo.repoPath, cacheKey: `probe:${id}:${process.env.CACHE_TAG ?? ''}` }, sha, dir, s.framework);
for (const i of ws.install) console.log('install', i.exitCode, i.durationMs, 'ms', i.output.slice(-300));
for (const seed of seeds) {
  const res = await runContainer({
    image: imageFor(s.framework), workspace: dir, cacheDir: ws.cacheDir, network: false, env: envFor(s.framework), timeoutSec: 180,
    command: testCommand(s.framework, { selection: {}, seed, resultFile: '/work/.alibi/result.json' }),
  });
  const counts = s.framework === 'maven' ? parseSurefireReports(dir) : parseJestResult(join(dir, '.alibi', 'result.json'));
  console.log(`seed=${seed} exit=${res.exitCode} ${res.durationMs}ms`, JSON.stringify(counts));
  if (process.env.SHOW) console.log(res.output.slice(-3000));
}
console.log('total', Date.now() - t0, 'ms');
