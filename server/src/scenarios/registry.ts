import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../config.js';
import type { Classification, Framework, RemediationType } from '../domain/types.js';

export interface ScenarioCommit {
  dir: string;
  message: string;
  author: string;
  date: string;
}

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  repository: string;
  framework: Framework;
  branch: string;
  workflow: string;
  job: string;
  ciCommand: string[];
  commits: ScenarioCommit[];
  expected: {
    classification: Classification;
    failingTest: { file: string; name: string };
    experiments: string[];
    remediation: RemediationType;
    notes: string;
  };
}

export const SCENARIO_DIR = join(ROOT_DIR, 'fixtures', 'scenarios');

export function listScenarios(): Scenario[] {
  return readdirSync(SCENARIO_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SCENARIO_DIR, d.name, 'scenario.json')))
    .map((d) => getScenario(d.name))
    .filter((s): s is Scenario => s !== null)
    .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
}

const ORDER = ['flaky-jest', 'maven-dependency', 'code-regression'];

export function getScenario(id: string): Scenario | null {
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  const file = join(SCENARIO_DIR, id, 'scenario.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as Scenario;
}

/** The recorded CI log for a scenario (captured from a real run by scripts/capture-ci-logs.ts). */
export function scenarioLogPath(id: string): string {
  return join(SCENARIO_DIR, id, 'ci-log.txt');
}

export function scenarioReplayPath(id: string): string {
  return join(SCENARIO_DIR, id, 'replay.json');
}
