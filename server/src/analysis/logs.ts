import type { Framework, LogStats } from '../domain/types.js';
import { GO_COMPILE_LINE } from '../runner/golang.js';
import { TSC_LINE } from '../runner/typescript.js';

export interface LogExcerpt {
  startLine: number;
  endLine: number;
  text: string;
  reason: string;
}

export interface FailingTest {
  name: string;
  file?: string;
}

export interface CompileError {
  file: string;
  line: number;
  message: string;
  symbol?: string;
  location?: string;
}

export interface LogFacts {
  framework: Framework;
  failingTests: FailingTest[];
  failingFiles: string[];
  compileErrors: CompileError[];
  /** Which tool reported the compile errors, when any were found. */
  compileTool: 'javac' | 'tsc' | 'go' | null;
  /** TypeScript: the log invoked tsc with tsconfig.build.json (a build, not only a type check). */
  tsBuild: boolean;
  /** Go: the compile errors came from `go test` (a package's tests did not build), not only `go build`. */
  goTestBuildFailed: boolean;
  assertion: string | null;
  jestSeed: number | null;
  exitCode: number | null;
  testSummary: string | null;
  downloads: Array<{ group: string; artifact: string; version: string }>;
  signature: string;
}

const GHA_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;
const ANSI = /\u001b\[[0-9;]*m/g;

/** Strips GitHub Actions timestamps and ANSI codes from one line. */
export function cleanLine(line: string): string {
  return line.replace(ANSI, '').replace(GHA_TS, '');
}

export function splitLines(log: string): string[] {
  return log.replace(/\r\n/g, '\n').split('\n');
}

const ANCHORS: Array<[RegExp, string, number]> = [
  [/##\[error\]/, 'GitHub Actions error', 5],
  [/\bCOMPILATION ERROR\b|cannot find symbol|error: /, 'compiler error', 5],
  [/^\S+\.tsx?\(\d+,\d+\): error TS\d+|^\S+\.tsx?:\d+:\d+ - error TS\d+/, 'TypeScript compiler error', 5],
  [/^\s*--- FAIL: Test/, 'Go test failure', 5],
  [/^(?:\.\/)?\S+\.go:\d+:\d+: |\[build failed\]|^# \S+$/, 'Go compiler error', 5],
  [/^\s*●\s/, 'Jest failure', 5],
  [/^FAIL\s+\S+/, 'Jest failing file', 4],
  [/^(FAILED|ERROR)\s+[^\s:]+\.py\b/, 'pytest failure', 5],
  [/^E\s{2,}\S/, 'pytest assertion', 3],
  [/^=+ short test summary info =+$|^=+ .*\b(failed|errors?)\b.* in [\d.]+s/, 'pytest summary', 3],
  [/BUILD FAILURE|<<< FAILURE!|Tests run:.*Failures: [1-9]/, 'Maven failure', 4],
  [/\bExpected\b|\bReceived\b|AssertionError|expected:<|but was:</, 'assertion', 3],
  [/^\s*at\s+\S+.*\(.*:\d+:\d+\)|^\s*at\s+[\w.$]+\(/, 'stack frame', 1],
  [/npm ERR!|ERR_|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|503 Service Unavailable|rate limit/i, 'environment error', 4],
  [/\b(Exception|Error):/, 'exception', 2],
  [/^Tests:\s+.*failed|^Test Suites:.*failed/, 'Jest summary', 3],
  [/Process completed with exit code [1-9]/, 'exit code', 3],
];

/**
 * Selects the regions of a (possibly very large) log most relevant to the
 * failure: scored anchor lines expanded with context, merged, and bounded by
 * `maxChars`. Line numbers are 1-based and refer to the stored, redacted log.
 */
export function selectExcerpts(log: string, maxChars: number, context = 6): LogExcerpt[] {
  const lines = splitLines(log);
  const hits: Array<{ line: number; score: number; reason: string }> = [];
  lines.forEach((raw, i) => {
    const line = cleanLine(raw);
    for (const [re, reason, score] of ANCHORS) {
      if (re.test(line)) {
        hits.push({ line: i, score, reason });
        break;
      }
    }
  });

  // Rank windows by anchor score, then keep merged windows until the budget is used.
  const windows = hits
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .map((h) => ({ start: Math.max(0, h.line - context), end: Math.min(lines.length - 1, h.line + context), reason: h.reason, score: h.score }));

  const chosen: Array<{ start: number; end: number; reasons: Set<string> }> = [];
  let used = 0;
  for (const w of windows) {
    const overlap = chosen.find((c) => w.start <= c.end + 1 && w.end >= c.start - 1);
    if (overlap) {
      const nextStart = Math.min(overlap.start, w.start);
      const nextEnd = Math.max(overlap.end, w.end);
      const added = lines.slice(nextStart, nextEnd + 1).join('\n').length - lines.slice(overlap.start, overlap.end + 1).join('\n').length;
      if (used + added > maxChars) continue;
      overlap.start = nextStart;
      overlap.end = nextEnd;
      overlap.reasons.add(w.reason);
      used += added;
      continue;
    }
    const size = lines.slice(w.start, w.end + 1).join('\n').length;
    if (used + size > maxChars) continue;
    chosen.push({ start: w.start, end: w.end, reasons: new Set([w.reason]) });
    used += size;
  }

  // Always include the log tail (where the final status lives) if budget allows.
  const tailStart = Math.max(0, lines.length - 15);
  if (!chosen.some((c) => c.end >= lines.length - 2)) {
    const size = lines.slice(tailStart).join('\n').length;
    if (used + size <= maxChars) chosen.push({ start: tailStart, end: lines.length - 1, reasons: new Set(['log tail']) });
  }

  return chosen
    .sort((a, b) => a.start - b.start)
    .map((c) => ({
      startLine: c.start + 1,
      endLine: c.end + 1,
      text: lines.slice(c.start, c.end + 1).map(cleanLine).join('\n'),
      reason: [...c.reasons].join(', '),
    }));
}

export function extractFacts(log: string, frameworkHint: Framework = 'unknown'): LogFacts {
  const lines = splitLines(log).map(cleanLine);
  const failingTests: FailingTest[] = [];
  const failingFiles: string[] = [];
  const compileErrors: CompileError[] = [];
  const downloads: LogFacts['downloads'] = [];
  let assertion: string | null = null;
  let jestSeed: number | null = null;
  let exitCode: number | null = null;
  let testSummary: string | null = null;
  let sawJest = false;
  let sawMaven = false;
  let sawPytest = false;
  let sawGo = false;
  let goTestBuildFailed = false;
  let goBuildHeader = false;
  let compileTool: LogFacts['compileTool'] = null;
  let tsBuild = false;
  let currentFile: string | undefined;
  const addCompile = (ce: CompileError, tool: NonNullable<LogFacts['compileTool']>) => {
    compileTool ??= tool;
    if (!compileErrors.some((c) => c.file === ce.file && c.line === ce.line && c.message === ce.message)) compileErrors.push(ce);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;

    if ((m = /^FAIL\s+(\S+\.(?:[cm]?[jt]sx?))/.exec(line))) {
      sawJest = true;
      currentFile = m[1];
      if (!failingFiles.includes(m[1])) failingFiles.push(m[1]);
    } else if ((m = /^\s*●\s+(.+?)\s*$/.exec(line)) && !/Console$/.test(m[1])) {
      sawJest = true;
      const name = m[1].replace(/\s+›\s+/g, ' ');
      if (!failingTests.some((t) => t.name === name)) failingTests.push({ name, file: currentFile });
    } else if ((m = /^Seed:\s+(-?\d+)/.exec(line))) {
      jestSeed = Number(m[1]);
    } else if ((m = /^(Tests:\s+.*)$/.exec(line))) {
      testSummary = m[1].trim();
    } else if ((m = /^\[ERROR\]\s+(\/\S+?\.(?:java|kt)):\[(\d+),(\d+)\]\s+(.+)$/.exec(line))) {
      sawMaven = true;
      const ce: CompileError = { file: m[1].replace(/^\/work\//, '').replace(/^\/home\/runner\/work\/[^/]+\/[^/]+\//, ''), line: Number(m[2]), message: m[4].trim() };
      const sym = /^(?:\[ERROR\])?\s+symbol:\s+(.+)$/.exec(lines[i + 1] ?? '');
      const loc = /^(?:\[ERROR\])?\s+location:\s+(.+)$/.exec(lines[i + 2] ?? '');
      if (sym) ce.symbol = sym[1].trim();
      if (loc) ce.location = loc[1].trim();
      addCompile(ce, 'javac');
    } else if ((m = /^\[ERROR\]\s+([A-Z][\w$]*Test[\w$]*)\.(\w+):(\d+)\s+(.*)$/.exec(line))) {
      sawMaven = true;
      const name = `${m[1]}#${m[2]}`;
      if (!failingTests.some((t) => t.name === name)) failingTests.push({ name, file: m[1] });
      assertion ??= m[4].trim();
    } else if ((m = /^\[ERROR\]\s+Tests run:\s+(\d+), Failures:\s+(\d+), Errors:\s+(\d+)/.exec(line)) || (m = /^\[(?:INFO|WARNING)\]\s+Tests run:\s+(\d+), Failures:\s+(\d+), Errors:\s+(\d+), Skipped:\s+\d+$/.exec(line))) {
      sawMaven = true;
      testSummary = line.replace(/^\[\w+\]\s+/, '');
    } else if ((m = /Download(?:ed|ing) from \S+: \S+?\/maven2\/(.+)\/([^/]+)\/([^/]+)\/\2-\3\.(?:jar|pom)/.exec(line))) {
      sawMaven = true;
      const d = { group: m[1].replace(/\//g, '.'), artifact: m[2], version: m[3] };
      if (!downloads.some((x) => x.group === d.group && x.artifact === d.artifact && x.version === d.version)) downloads.push(d);
    } else if ((m = /^(FAILED|ERROR)\s+([^\s:]+\.py)(?:::(.+?))?(?:\s+-\s+(.*))?\s*$/.exec(line))) {
      // pytest short test summary: "FAILED tests/test_a.py::TestK::test_p[2] - assert 2 == 1".
      sawPytest = true;
      if (!failingFiles.includes(m[2])) failingFiles.push(m[2]);
      if (m[3] && !failingTests.some((t) => t.name === m![3] && t.file === m![2])) failingTests.push({ name: m[3], file: m[2] });
      if (m[4]) assertion ??= m[4].trim();
    } else if (/^=+ test session starts =+$/.test(line)) {
      sawPytest = true;
    } else if (sawPytest && (m = /^=*\s*(\d+ (?:failed|passed|errors?|skipped)\b.*? in [\d.]+s\b.*?)\s*=*$/.exec(line))) {
      testSummary = m[1].trim();
    } else if ((m = TSC_LINE.exec(line))) {
      // Top-level tsc output only; ts-jest diagnostics are indented inside a Jest suite failure.
      addCompile({ file: m[1], line: Number(m[2] ?? m[4]), message: `${m[6]}: ${m[7].trim()}` }, 'tsc');
    } else if ((m = /^\s*--- FAIL: (Test[A-Za-z0-9_]*(?:\/\S+)?) \([\d.]+s\)/.exec(line))) {
      sawGo = true;
      const name = m[1];
      if (!failingTests.some((t) => t.name === name)) failingTests.push({ name });
      // First indented diagnostic below the failure, e.g. "    rates_test.go:12: got 899, want 499".
      const detail = /^\s+(\S+_test\.go:\d+: .+)$/.exec(lines[i + 1] ?? '');
      if (detail) assertion ??= detail[1].trim();
    } else if ((m = /^FAIL\s+(\S+)\s+\[(build|setup) failed\]/.exec(line))) {
      sawGo = true;
      goTestBuildFailed = true;
    } else if (/^(ok|FAIL|\?)\s+[A-Za-z0-9][\w.~\/-]*\s+(\(cached\)|[\d.]+s|\[no test files\])/.test(line)) {
      sawGo = true;
    } else if (/^# [A-Za-z0-9][\w.~\/-]*( \[[\w.~\/-]+\.test\])?$/.test(line)) {
      // "# example.com/pkg" introduces the compiler output for one package.
      goBuildHeader = true;
      sawGo = true;
    } else if (goBuildHeader && (m = GO_COMPILE_LINE.exec(line)) && m[3]) {
      addCompile({ file: m[1], line: Number(m[2]), message: m[4].trim() }, 'go');
    } else if ((m = /Process completed with exit code (\d+)/.exec(line))) {
      exitCode = Number(m[1]);
    } else if (/BUILD FAILURE|\[INFO\] Scanning for projects/.test(line)) {
      sawMaven = true;
    }
    if (/\btsc\b.*\btsconfig\.build\.json\b/.test(line)) tsBuild = true;
    if (goBuildHeader && !line.trim()) goBuildHeader = false;

    if (!assertion && sawPytest && /^E\s{2,}\S/.test(line)) {
      // First pytest "E" block (assertion or exception), up to three lines.
      const block: string[] = [];
      for (let j = i; j < lines.length && block.length < 3 && /^E\s/.test(lines[j]); j++) block.push(lines[j].slice(1).trim());
      assertion = block.filter(Boolean).join(' | ');
    }
    if (!assertion && sawJest && /^\s*(Expected|Received|expect\()/.test(line)) {
      assertion = lines.slice(i, i + 4).map((l) => l.trim()).filter(Boolean).join(' | ');
    }
  }

  // Mocha: "N failing" followed by numbered failures, e.g. "1) suite\n  nested\n    test name:".
  let sawMocha = false;
  const failingAt = lines.findIndex((l) => /^\s*\d+ failing\s*$/.test(l));
  if (failingAt >= 0 && !sawJest && !sawMaven && !sawPytest) {
    sawMocha = true;
    testSummary ??= lines.slice(Math.max(0, failingAt - 3), failingAt + 1).map((l) => l.trim()).filter(Boolean).join(', ');
    for (let i = failingAt + 1; i < lines.length && failingTests.length < 20; i++) {
      const head = /^\s*\d+\)\s+(.+)$/.exec(lines[i]);
      if (!head) continue;
      const parts = [head[1].trim()];
      let j = i + 1;
      for (; j < lines.length && j < i + 8; j++) {
        const t = lines[j].trim();
        if (!t) continue;
        parts.push(t.replace(/:$/, ''));
        if (t.endsWith(':')) break;
      }
      if (!failingTests.some((t) => t.name === parts.join(' '))) failingTests.push({ name: parts.join(' ') });
      const msg = lines.slice(j + 1, j + 6).map((l) => l.trim()).find((l) => /Error|expected|assert/i.test(l));
      assertion ??= msg ?? null;
      const loc = lines.slice(j + 1, j + 20).map((l) => /^\s*at .*\(((?!node:)[^():]+\.[cm]?[jt]s):\d+:\d+\)/.exec(l)?.[1]).find(Boolean);
      if (loc && !failingFiles.includes(loc)) failingFiles.push(loc);
    }
  }

  const framework: Framework = frameworkHint !== 'unknown' ? frameworkHint : sawMaven ? 'maven' : sawJest ? 'jest' : sawPytest ? 'pytest' : sawGo ? 'go' : sawMocha ? 'mocha' : 'unknown';
  // Go: a parent test is reported failed whenever a subtest fails; keep the most specific names.
  const tests = framework === 'go' ? failingTests.filter((t) => !failingTests.some((o) => o.name.startsWith(`${t.name}/`))) : failingTests;
  if (compileErrors.some((c) => c.file.endsWith('_test.go'))) goTestBuildFailed = true;
  return {
    framework,
    failingTests: tests,
    failingFiles,
    compileErrors,
    compileTool,
    tsBuild,
    goTestBuildFailed,
    assertion,
    jestSeed,
    exitCode,
    testSummary,
    downloads,
    signature: buildSignature(framework, tests, compileErrors, failingFiles, assertion),
  };
}

/** Stable, human-readable failure signature derived only from observed log facts. */
export function buildSignature(
  framework: Framework,
  tests: FailingTest[],
  compileErrors: CompileError[],
  files: string[],
  assertion: string | null,
): string {
  if (compileErrors.length) {
    const c = compileErrors[0];
    const where = c.file.split('/').pop();
    const detail = [c.message, c.symbol && `symbol ${c.symbol}`, c.location && `in ${c.location}`].filter(Boolean).join(', ');
    return `${framework}: compilation error at ${where}:${c.line} — ${detail}`;
  }
  if (tests.length) {
    const t = tests[0];
    const more = tests.length > 1 ? ` (+${tests.length - 1} more)` : '';
    const file = t.file ? `${t.file} › ` : '';
    const a = assertion ? ` — ${assertion.split(' | ')[0]}` : '';
    return `${framework}: ${file}${t.name}${more}${a}`.slice(0, 300);
  }
  if (files.length) return `${framework}: failing suite ${files[0]}`;
  return `${framework}: build failed without a recognizable test failure`;
}

export function logStats(log: string, excerpts: LogExcerpt[], redactions: number): LogStats {
  return {
    totalLines: splitLines(log).length,
    totalChars: log.length,
    sentChars: excerpts.reduce((n, e) => n + e.text.length, 0),
    excerptCount: excerpts.length,
    redactions,
  };
}

/** Checks a model-cited quote against the log; tolerant to whitespace and nearby lines. */
export function verifyQuote(log: string, quote: string, line?: number | null): { verified: boolean; line: number | null } {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const q = norm(quote).replace(/^["'`]|["'`]$/g, '');
  if (q.length < 6) return { verified: false, line: line ?? null };
  const lines = splitLines(log).map(cleanLine);
  if (line && line >= 1 && line <= lines.length) {
    for (let i = Math.max(0, line - 4); i < Math.min(lines.length, line + 3); i++) {
      if (norm(lines[i]).includes(q) || (q.length > 20 && q.includes(norm(lines[i])) && norm(lines[i]).length > 12)) return { verified: true, line: i + 1 };
    }
  }
  const idx = lines.findIndex((l) => norm(l).includes(q));
  return idx >= 0 ? { verified: true, line: idx + 1 } : { verified: false, line: line ?? null };
}
