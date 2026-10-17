import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { Framework, TestCounts } from '../domain/types.js';
import { GO_ENV, GO_INSTALL_ENV, goRunPattern, isGoPackageDir, isGoTestName } from './golang.js';
import { fileReader, isPytestName, looksLikePytest, PY_BIN, PY_VENV, PYPI_INDEX } from './python.js';
import { TSCONFIG, type TsCheck } from './typescript.js';

export interface TestSelection {
  /** Repo-relative test file (Jest, pytest) or fully-qualified class (Maven). */
  file?: string;
  /** Jest: full test name. Maven: method name. pytest: node-id tail, e.g. "TestK::test_x[1]". Go: test name, optionally with a subtest path. */
  name?: string;
  /**
   * A compile check instead of tests. Jest projects with TypeScript: "typecheck" (tsc on tsconfig.json) or
   * "build" (tsc on tsconfig.build.json). Go: "build" (go build ./...). Selections with a check carry no file or name.
   */
  check?: TsCheck;
}

const SAFE_PATH = /^[A-Za-z0-9_./-]{1,200}$/;
const SAFE_JAVA = /^[A-Za-z0-9_.$]{1,200}$/;
const SAFE_METHOD = /^[A-Za-z0-9_$]{1,120}$/;

/** Deterministic validation of a model- or log-derived test selection. */
export function validateSelection(framework: Framework, sel: TestSelection): TestSelection {
  const out: TestSelection = {};
  if (sel.check === 'build' && (framework === 'go' || framework === 'jest')) return { check: 'build' };
  if (sel.check === 'typecheck' && framework === 'jest') return { check: 'typecheck' };
  if (framework === 'go') {
    // Go: a "./"-rooted package directory and a test name, both from fixed character sets.
    if (sel.file && isGoPackageDir(sel.file)) out.file = sel.file;
    if (sel.name && isGoTestName(sel.name)) out.name = sel.name;
    return out;
  }
  if (sel.file) {
    if (framework === 'maven') {
      if (SAFE_JAVA.test(sel.file)) out.file = sel.file;
    } else if (framework === 'pytest' && !sel.file.endsWith('.py')) {
      // pytest selections are node IDs rooted at a .py file; anything else is dropped.
    } else if (SAFE_PATH.test(sel.file) && !sel.file.includes('..') && !sel.file.startsWith('/') && !sel.file.split('/').some((seg) => seg.startsWith('-'))) {
      // No path segment may start with "-": a log-derived name must never be read as a CLI option.
      out.file = sel.file;
    }
  }
  if (sel.name) {
    if (framework === 'maven') {
      if (SAFE_METHOD.test(sel.name)) out.name = sel.name;
    } else if (framework === 'pytest') {
      // A node-id tail is only meaningful under its file.
      if (out.file && isPytestName(sel.name)) out.name = sel.name;
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
  if (existsSync(join(workspace, 'go.mod'))) return 'go';
  if (looksLikePytest(fileReader(workspace))) return 'pytest';
  return 'unknown';
}

export function imageFor(framework: Framework): string {
  if (framework === 'pytest') return config.runner.pythonImage;
  if (framework === 'go') return config.runner.goImage;
  return framework === 'maven' ? config.runner.mavenImage : config.runner.nodeImage;
}

const MAVEN_ENV = { MAVEN_OPTS: '-Duser.home=/tmp -Xmx768m', MAVEN_CONFIG: '/tmp/.m2' };

/** pip ignores any configuration a repository could provide; bytecode is not written into the checkout. */
const PYTHON_ENV = {
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONPATH: '/work/src',
  PIP_CONFIG_FILE: '/dev/null',
  PIP_NO_INPUT: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
};

export function envFor(framework: Framework): Record<string, string> {
  if (framework === 'pytest') return PYTHON_ENV;
  if (framework === 'go') return GO_ENV;
  return framework === 'maven' ? MAVEN_ENV : { NODE_OPTIONS: '--max-old-space-size=768' };
}

/** Environment for the network-enabled install step (Go switches the module proxy on; others are unchanged). */
export function installEnvFor(framework: Framework): Record<string, string> {
  return framework === 'go' ? GO_INSTALL_ENV : envFor(framework);
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
export function installCommands(framework: Framework, hasLockfile: boolean, workspace?: string, requirementFiles: string[] = []): string[][] {
  // Go: downloads every module in the build list and verifies it against go.sum. No repository code runs.
  if (framework === 'go') return [['go', 'mod', 'download']];
  if (framework === 'pytest') {
    // Isolated mode (-I): neither the checkout nor PYTHONPATH is importable while the network is on.
    // Wheels only: no package build step (setup.py, build backends) runs. Index fixed to PyPI.
    return [
      ['python', '-I', '-m', 'venv', PY_VENV],
      [PY_BIN, '-I', '-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '--only-binary=:all:',
        '--index-url', PYPI_INDEX, '--cache-dir', '/cache/pip', ...requirementFiles.flatMap((f) => ['-r', f])],
    ];
  }
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
  if (framework === 'go') {
    if (sel.check === 'build') return ['go', 'build', './...'];
    const cmd = ['go', 'test', '-json', '-count=1'];
    // -shuffle randomizes test order with a replayable seed (it does not seed math/rand inside tests).
    if (opts.seed !== undefined) cmd.push(`-shuffle=${opts.seed}`);
    if (sel.name) cmd.push('-run', goRunPattern(sel.name));
    // Package arguments are validated "./"-rooted directories, so they can never be read as flags.
    cmd.push(sel.file ?? './...');
    return cmd;
  }
  if (sel.check) {
    // TypeScript type check or build with a fixed tsconfig name; output goes to a scratch directory.
    return sel.check === 'typecheck'
      ? ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false', '-p', TSCONFIG.typecheck]
      : ['node', 'node_modules/typescript/bin/tsc', '--pretty', 'false', '-p', TSCONFIG.build, '--outDir', '.alibi/tsc-build'];
  }
  if (framework === 'maven') {
    const cmd = ['mvn', '-B', '-o', '-Dmaven.repo.local=/cache/m2', 'test'];
    if (sel.file) {
      const cls = sel.file.split('.').pop()!;
      cmd.push(`-Dtest=${sel.name ? `${cls}#${sel.name}` : cls}`, '-Dsurefire.failIfNoSpecifiedTests=false');
    }
    return cmd;
  }
  if (framework === 'pytest') {
    const cmd = [PY_BIN, '-m', 'pytest', '-p', 'no:cacheprovider', '-o', 'junit_family=xunit1', `--junitxml=${opts.resultFile}`,
      '-rfE', '--tb=short', '--color=no', '--ignore=.alibi'];
    // Options end at "--": the node ID that follows is always positional.
    if (sel.file) cmd.push('--', sel.name ? `${sel.file}::${sel.name}` : sel.file);
    return cmd;
  }
  const cmd = ['node', 'node_modules/jest/bin/jest.js', '--ci', '--json', `--outputFile=${opts.resultFile}`];
  if (opts.seed !== undefined) cmd.push(`--seed=${opts.seed}`);
  if (sel.name) cmd.push('-t', `^${escapeRegex(sel.name)}$`);
  // Options end at "--": the path that follows is always a positional argument.
  if (sel.file) cmd.push('--runTestsByPath', '--', sel.file);
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
