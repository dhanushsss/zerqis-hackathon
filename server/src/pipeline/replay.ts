import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { scenarioReplayPath } from '../scenarios/registry.js';

/**
 * Recorded outputs of real Nemotron calls for a demo scenario. Replay mode
 * re-uses them (clearly labeled) so the demo works without an API key.
 */
export interface ReplayRecording {
  scenarioId: string;
  recordedAt: string;
  investigationId: string;
  baseUrl: string;
  steps: Record<string, { model: string; output: unknown; recordedAt: string }>;
}

function dataPath(id: string) {
  return join(config.dataDir, 'replays', `${id}.json`);
}

export function loadReplay(scenarioId: string): ReplayRecording | null {
  for (const p of [dataPath(scenarioId), scenarioReplayPath(scenarioId)]) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as ReplayRecording;
      } catch {
        // ignore unreadable recordings
      }
    }
  }
  return null;
}

export function saveReplay(rec: ReplayRecording): void {
  mkdirSync(join(config.dataDir, 'replays'), { recursive: true });
  writeFileSync(dataPath(rec.scenarioId), JSON.stringify(rec, null, 2));
}
