import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { TestCounts } from '../domain/types.js';

/**
 * Go policy. One layout is supported: a single module with go.mod at the
 * repository root, dependencies fetched from the public module proxy and checked
 * against go.sum (`go mod download`, network on, no repository code runs), then
 * `go test` / `go build` offline with GOPROXY=off, -mod=readonly, and
 * GOTOOLCHAIN=local. Everything else is reported as unsupported instead of guessed.
 */

/** Module and build caches live on the per-repository cache mount, not in the checkout. */
export const GO_ENV = {
  GOMODCACHE: '/cache/gomod',
  GOCACHE: '/cache/gobuild',
  GOPATH: '/tmp/go',
  // -modcacherw: Go writes its module cache read-only, which would make the cache impossible to delete.
  GOFLAGS: '-mod=readonly -modcacherw',
  GOTOOLCHAIN: 'local',
  CGO_ENABLED: '0',
  GOPROXY: 'off',
};

/** Install step only: the public proxy and checksum database, nothing a repository can redirect. */
export const GO_INSTALL_ENV = { ...GO_ENV, GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org' };

/** Go version of the pinned image; a module needing a newer language version is unsupported. */
export const GO_IMAGE_VERSION: [number, number] = [1, 24];

export type GoLayout = { ok: true; module: string; goVersion: string } | { ok: false; reason: string };

const SUPPORTED = 'Supported: a single Go module with go.mod (and go.sum when it has dependencies) at the repository root, dependencies from the public module proxy.';
const MODULE_PATH = /^[A-Za-z0-9][A-Za-z0-9._~\-/]{0,199}$/;

/** Decides whether a checkout can be installed and tested. `read` returns a root-relative file's text, or null. */
export function goLayout(read: (path: string) => string | null): GoLayout {
  const mod = read('go.mod');
  if (mod === null) return { ok: false, reason: `No go.mod at the repository root. ${SUPPORTED}` };
  if (read('go.work') !== null) return { ok: false, reason: `Go workspaces (go.work) are not supported. ${SUPPORTED}` };
  if (read('vendor/modules.txt') !== null) return { ok: false, reason: `Vendored dependencies (vendor/) are not supported yet. ${SUPPORTED}` };
  const module = /^module\s+("?)([^\s"]+)\1\s*$/m.exec(mod)?.[2];
  if (!module || !MODULE_PATH.test(module)) return { ok: false, reason: `go.mod does not declare a recognizable module path. ${SUPPORTED}` };
  const goVersion = /^go\s+(\d+)\.(\d+)(?:\.\d+)?\s*$/m.exec(mod);
  if (!goVersion) return { ok: false, reason: `go.mod does not declare a go version. ${SUPPORTED}` };
  const [maj, min] = [Number(goVersion[1]), Number(goVersion[2])];
  if (maj > GO_IMAGE_VERSION[0] || (maj === GO_IMAGE_VERSION[0] && min > GO_IMAGE_VERSION[1])) {
    return { ok: false, reason: `go.mod requires Go ${maj}.${min}, newer than the sandbox's Go ${GO_IMAGE_VERSION.join('.')}; toolchains are never downloaded. ${SUPPORTED}` };
  }
  const local = replaceIssue(mod);
  if (local) return { ok: false, reason: `${local} ${SUPPORTED}` };
  if (/^\s*require\b/m.test(mod) && read('go.sum') === null) return { ok: false, reason: `go.mod requires modules but go.sum is missing, so downloads cannot be verified. ${SUPPORTED}` };
  return { ok: true, module, goVersion: `${maj}.${min}` };
}

/** A replace directive pointing at a filesystem path would build code from outside the checkout. */
export function replaceIssue(mod: string): string | null {
  const lines = mod.split('\n');
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (/^replace\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const body = inBlock ? line : /^replace\s+(.*)$/.exec(line)?.[1];
    if (!body) continue;
    const target = body.split('=>')[1]?.trim() ?? '';
    if (/^(\.\.?\/|\/|[A-Za-z]:\\)/.test(target)) return `go.mod replaces a module with a local path (${target.split(/\s/)[0]}), which is not supported.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Selections. A Go selection is a package directory (relative, "./"-rooted)
// plus an optional test name; both are validated before they reach argv.

const PKG_DIR = /^\.(\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}){0,12}$/;
const TEST_NAME = /^Test[A-Za-z0-9_]{0,120}(\/[A-Za-z0-9_#.+=:,-]{1,120}){0,4}$/;

export function isGoPackageDir(p: string): boolean {
  return PKG_DIR.test(p) && !p.split('/').some((s) => s === '..' || s === 'testdata' || s.startsWith('-'));
}

export function isGoTestName(n: string): boolean {
  return TEST_NAME.test(n);
}

/** `-run` pattern that matches exactly one top-level test, or one subtest path. */
export function goRunPattern(name: string): string {
  return name
    .split('/')
    .map((part) => `^${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    .join('/');
}

/** Converts a reported import path to a "./"-rooted directory inside `module`, or null. */
export function packageDir(importPath: string, module: string): string | null {
  if (importPath === module) return '.';
  if (!importPath.startsWith(`${module}/`)) return null;
  const dir = `./${importPath.slice(module.length + 1)}`;
  return isGoPackageDir(dir) ? dir : null;
}

// ---------------------------------------------------------------------------
// Results

interface GoEvent {
  Action?: string;
  Package?: string;
  ImportPath?: string;
  Test?: string;
  Output?: string;
  FailedBuild?: string;
}

export interface GoRun {
  counts: TestCounts | null;
  /** Packages whose build failed (compiler output is in `buildOutput`). */
  buildFailed: string[];
  buildOutput: string[];
}

/** Parses `go test -json` output. Leaf tests are counted; a failed build makes counts null. */
export function parseGoTestJson(output: string): GoRun {
  const status = new Map<string, 'pass' | 'fail' | 'skip'>();
  const buildFailed = new Set<string>();
  const buildOutput: string[] = [];
  let sawEvent = false;
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e: GoEvent;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    sawEvent = true;
    if (e.Action === 'build-output' && e.Output) buildOutput.push(e.Output.replace(/\n$/, ''));
    if (e.Action === 'build-fail' && e.ImportPath) buildFailed.add(e.ImportPath);
    if (e.Action === 'fail' && e.FailedBuild) buildFailed.add(e.FailedBuild);
    if (e.Test && e.Package && (e.Action === 'pass' || e.Action === 'fail' || e.Action === 'skip')) status.set(`${e.Package} ${e.Test}`, e.Action);
  }
  if (!sawEvent) return { counts: null, buildFailed: [], buildOutput: [] };
  if (buildFailed.size) return { counts: null, buildFailed: [...buildFailed], buildOutput };
  // A parent test is reported as failed whenever a subtest fails; count leaves only.
  const keys = [...status.keys()];
  const leaves = keys.filter((k) => !keys.some((o) => o.startsWith(`${k}/`)));
  let passed = 0;
  let failed = 0;
  const failedNames: string[] = [];
  for (const k of leaves) {
    const s = status.get(k)!;
    if (s === 'skip') continue;
    if (s === 'pass') passed++;
    else {
      failed++;
      failedNames.push(k);
    }
  }
  if (passed + failed === 0) return { counts: null, buildFailed: [], buildOutput };
  return { counts: { total: passed + failed, passed, failed, failedNames }, buildFailed: [], buildOutput };
}

/** Compiler diagnostics in `go build` / `go vet` text output: "path/file.go:12:3: message". */
export const GO_COMPILE_LINE = /^(?:\.\/)?((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.go):(\d+)(?::(\d+))?: (.+)$/;

/** Version requirement changes in go.mod hunk lines ("+\tgithub.com/x/y v1.2.3" or "+require x v1"). */
export const GO_REQUIRE_LINE = /^[+-]\s*(?:require\s+)?([A-Za-z0-9][A-Za-z0-9._~\-/]*\.[A-Za-z0-9._~\-/]+)\s+(v[0-9][\w.+-]*)(?:\s*\/\/\s*indirect)?\s*$/;

/**
 * Finds the _test.go file that declares top-level `testName` (bounded walk of the checkout;
 * vendor, testdata, and dot-directories are skipped). Returns a repo-relative path or null.
 */
export function findGoTestFile(root: string, testName: string, maxFiles = 2000): string | null {
  const top = testName.split('/')[0];
  if (!isGoTestName(top)) return null;
  const decl = new RegExp(`^func\\s+${top}\\s*\\(\\s*\\w+\\s+\\*testing\\.T\\s*\\)`, 'm');
  const stack = [''];
  let seen = 0;
  while (stack.length && seen < maxFiles) {
    const rel = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'vendor' && e.name !== 'testdata' && e.name !== 'node_modules') stack.push(p);
      } else if (e.isFile() && e.name.endsWith('_test.go')) {
        seen++;
        try {
          if (decl.test(readFileSync(join(root, p), 'utf8'))) return p;
        } catch {
          // unreadable file: keep looking
        }
      }
    }
  }
  return null;
}
