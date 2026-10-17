import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { Framework, TestCounts } from '../domain/types.js';

export interface TestSelection {
  /** Repo-relative test file (Jest) or fully-qualified class (Maven). */
  file?: string;
  /** Jest: full test name. Maven: method name. */
  name?: string;
}

const SAFE_PATH = /^[A-Za-z0-9_./-]{1,200}$/;
const SAFE_JAVA = /^[A-Za-z0-9_.$]{1,200}$/;
const SAFE_METHOD = /^[A-Za-z0-9_$]{1,120}$/;

/** Deterministic validation of a model- or log-derived test selection. */
export function validateSelection(framework: Framework, sel: TestSelection): TestSelection {
  const out: TestSelection = {};
  if (sel.file) {
    if (framework === 'maven') {
      if (SAFE_JAVA.test(sel.file)) out.file = sel.file;
    } else if (SAFE_PATH.test(sel.file) && !sel.file.includes('..') && !sel.file.startsWith('/')) {
      out.file = sel.file;
    }
  }
  if (sel.name) {
    if (framework === 'maven') {
      if (SAFE_METHOD.test(sel.name)) out.name = sel.name;
    } else if (sel.name.length <= 300 && !/[\0\n\r]/.test(sel.name)) {
      out.name = sel.name;
    }
  }
  return out;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectFramework(workspace: string): Framework {
  if (existsSync(join(workspace, 'pom.xml'))) return 'maven';
  const pkg = join(workspace, 'package.json');
  if (existsSync(pkg)) {
    try {
      const json = JSON.parse(readFileSync(pkg, 'utf8'));
      const deps = { ...json.dependencies, ...json.devDependencies };
      if (deps.jest || /\bjest\b/.test(json.scripts?.test ?? '')) return 'jest';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

export function imageFor(framework: Framework): string {
  return framework === 'maven' ? config.runner.mavenImage : config.runner.nodeImage;
}

const MAVEN_ENV = { MAVEN_OPTS: '-Duser.home=/tmp -Xmx768m', MAVEN_CONFIG: '/tmp/.m2' };

export function envFor(framework: Framework): Record<string, string> {
  return framework === 'maven' ? MAVEN_ENV : { NODE_OPTIONS: '--max-old-space-size=768' };
}

/** Surefire version declared in pom.xml, if it is a literal version. */
export function surefireVersion(workspace: string): string | null {
  const pom = join(workspace, 'pom.xml');
  if (!existsSync(pom)) return null;
  const xml = readFileSync(pom, 'utf8');
  const m = /<artifactId>maven-surefire-plugin<\/artifactId>\s*<version>([0-9][\w.-]{0,30})<\/version>/.exec(xml);
  return m ? m[1] : null;
}

/**
 * Network-enabled dependency preparation steps (no secrets are present).
 * Maven: go-offline, then fetch Surefire's lazily-resolved JUnit Platform
 * provider. Nothing from the repository's test code executes in this phase.
 */
export function installCommands(framework: Framework, hasLockfile: boolean, workspace?: string): string[][] {
  if (framework === 'maven') {
    const surefire = (workspace && surefireVersion(workspace)) || '3.2.5';
    return [
      ['mvn', '-B', '-q', '-Dmaven.repo.local=/cache/m2', 'dependency:go-offline'],
      ['mvn', '-B', '-q', '-Dmaven.repo.local=/cache/m2', 'dependency:get',
        `-Dartifact=org.apache.maven.surefire:surefire-junit-platform:${surefire}`],
    ];
  }
  return [
    hasLockfile
      ? ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', '/cache/npm']
      : ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', '/cache/npm'],
  ];
}

export interface TestCommandOptions {
  selection: TestSelection;
  seed?: number;
  resultFile: string;
}

/** Offline test command. Arguments are fixed templates plus validated selection values. */
export function testCommand(framework: Framework, opts: TestCommandOptions): string[] {
  const sel = validateSelection(framework, opts.selection);
  if (framework === 'maven') {
    const cmd = ['mvn', '-B', '-o', '-Dmaven.repo.local=/cache/m2', 'test'];
    if (sel.file) {
      const cls = sel.file.split('.').pop()!;
      cmd.push(`-Dtest=${sel.name ? `${cls}#${sel.name}` : cls}`, '-Dsurefire.failIfNoSpecifiedTests=false');
    }
    return cmd;
  }
  const cmd = ['node', 'node_modules/jest/bin/jest.js', '--ci', '--json', `--outputFile=${opts.resultFile}`];
  if (opts.seed !== undefined) cmd.push(`--seed=${opts.seed}`);
  if (sel.file) cmd.push('--runTestsByPath', sel.file);
  if (sel.name) cmd.push('-t', `^${escapeRegex(sel.name)}$`);
  return cmd;
}

/** Parses Jest's --json output file. */
export function parseJestResult(file: string): TestCounts | null {
  if (!existsSync(file)) return null;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const failedNames: string[] = [];
    let total = 0;
    let passed = 0;
    let failed = 0;
    for (const suite of json.testResults ?? []) {
      for (const a of suite.assertionResults ?? []) {
        if (a.status === 'pending' || a.status === 'skipped' || a.status === 'disabled') continue;
        total++;
        if (a.status === 'passed') passed++;
        else {
          failed++;
          failedNames.push(a.fullName);
        }
      }
      if (suite.status === 'failed' && (suite.assertionResults ?? []).length === 0) {
        failed++;
        total++;
        failedNames.push(`${suite.name}: ${String(suite.message ?? 'suite failed').split('\n')[0]}`);
      }
    }
    return { total, passed, failed, failedNames };
  } catch {
    return null;
  }
}

/** Parses Surefire XML reports under target/surefire-reports. */
export function parseSurefireReports(workspace: string): TestCounts | null {
  const dir = join(workspace, 'target', 'surefire-reports');
  if (!existsSync(dir)) return null;
  let total = 0;
  let failed = 0;
  const failedNames: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.startsWith('TEST-') && n.endsWith('.xml'))) {
    const xml = readFileSync(join(dir, f), 'utf8');
    for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attrs = m[1];
      const body = m[3] ?? '';
      if (/<skipped\b/.test(body)) continue;
      total++;
      if (/<(failure|error)\b/.test(body)) {
        failed++;
        const name = /name="([^"]+)"/.exec(attrs)?.[1] ?? '?';
        const cls = /classname="([^"]+)"/.exec(attrs)?.[1] ?? '?';
        failedNames.push(`${cls}#${name}`);
      }
    }
  }
  return total === 0 && failed === 0 ? null : { total, passed: total - failed, failed, failedNames };
}

export function hasLockfile(workspace: string): boolean {
  return existsSync(join(workspace, 'package-lock.json'));
}
