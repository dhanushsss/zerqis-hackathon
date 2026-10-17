/** Copies replays recorded by live runs (data/replays) into fixtures so a deployment without a key can replay real Nemotron output. */
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../server/src/config.js';
import { listScenarios, scenarioReplayPath } from '../server/src/scenarios/registry.js';

for (const s of listScenarios()) {
  const src = join(config.dataDir, 'replays', `${s.id}.json`);
  if (!existsSync(src)) {
    console.log(`${s.id}: no live recording yet (run it in live mode first)`);
    continue;
  }
  copyFileSync(src, scenarioReplayPath(s.id));
  console.log(`${s.id}: exported -> ${scenarioReplayPath(s.id)}`);
}
