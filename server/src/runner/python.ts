import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TestCounts } from '../domain/types.js';
import { PRODUCT_NAME } from '../brand.js';

/**
 * Python/pytest policy. Only one layout is supported: root-level requirements
 * files that list PyPI packages (with optional version specifiers and markers),
 * one of which declares pytest. Everything else is reported as unsupported
 * rather than guessed at, because installing it would mean running code from
 * the repository (setup.py, build backends) or fetching from places other than
 * PyPI (URLs, VCS, local paths, custom indexes) with the network enabled.
 */

/** Virtualenv created inside the workspace (git-ignored via .alibi/.gitignore). */
export const PY_VENV = '/work/.alibi/venv';
export const PY_BIN = `${PY_VENV}/bin/python`;
export const PYPI_INDEX = 'https://pypi.org/simple';

export const REQUIREMENT_FILES = ['requirements.txt', 'requirements-dev.txt', 'requirements-test.txt', 'dev-requirements.txt', 'test-requirements.txt'];

export function isRequirementsFile(path: string): boolean {
  return REQUIREMENT_FILES.includes(path);
}

/** PEP 508 name, optional extras, optional version specifiers, optional environment marker. No URLs, paths, or options. */
const SPEC = String.raw`(?:===?|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]{1,40}`;
const REQ_LINE = new RegExp(
  String.raw`^([A-Za-z0-9][A-Za-z0-9._-]{0,99})(?:\[[A-Za-z0-9._,\s-]{1,100}\])?\s*(${SPEC}(?:\s*,\s*${SPEC}){0,5})?\s*(?:;\s*[A-Za-z0-9_.'"<>=!~\s()-]{1,200})?$`,
);
const MAX_REQ_BYTES = 64 * 1024;
const MAX_REQ_LINES = 300;

function stripComment(line: string): string {
  return line.replace(/(^|\s)#.*$/, '').trim();
}

/** Why one requirements line is not allowed, or null when it is a plain PyPI requirement (or blank/comment). */
export function requirementIssue(raw: string): string | null {
  const line = stripComment(raw);
  if (!line) return null;
  if (line.endsWith('\\')) return 'line continuations are not supported';
  if (line.startsWith('-')) return `pip options are not allowed (${line.split(/\s/)[0]})`;
  if (/:\/\/|@|^\.|\//.test(line)) return 'URL, VCS, and local-path requirements are not allowed';
  if (!REQ_LINE.test(line)) return 'not a recognizable PyPI requirement';
  return null;
}

/** Normalized package name and specifier of an allowed requirements line. */
export function parseRequirement(raw: string): { name: string; spec: string } | null {
  const line = stripComment(raw);
  if (!line || requirementIssue(line)) return null;
  const m = REQ_LINE.exec(line)!;
  return { name: m[1].toLowerCase().replace(/[-_.]+/g, '-'), spec: (m[2] ?? '').replace(/\s+/g, '') };
}

export type PythonLayout = { ok: true; requirementFiles: string[] } | { ok: false; reason: string };

const SUPPORTED = 'Supported: PyPI requirements in root-level requirements.txt (optionally requirements-dev.txt or requirements-test.txt) that include pytest.';

/** Decides whether a checkout can be installed and tested. `read` returns a root-relative file's text, or null. */
export function pythonLayout(read: (path: string) => string | null): PythonLayout {
  const files = REQUIREMENT_FILES.filter((f) => read(f) !== null);
  if (!files.length) {
    const pyproject = read('pyproject.toml') ?? '';
    const tool =
      read('Pipfile') !== null ? 'Pipenv (Pipfile)'
      : read('poetry.lock') !== null || /^\[tool\.poetry\b/m.test(pyproject) ? 'Poetry'
      : read('uv.lock') !== null ? 'uv (uv.lock)'
      : read('environment.yml') !== null ? 'conda (environment.yml)'
      : /^\[project\]/m.test(pyproject) && /^dependencies\s*=/m.test(pyproject) ? 'pyproject.toml [project] dependencies'
      : read('setup.py') !== null ? 'setup.py'
      : null;
    return {
      ok: false,
      reason: tool
        ? `Dependencies are declared with ${tool}, which ${PRODUCT_NAME} does not install (it would run the project's build or resolver configuration with network access). ${SUPPORTED}`
        : `No requirements file was found, so dependencies cannot be installed. ${SUPPORTED}`,
    };
  }
  let declaresPytest = false;
  for (const f of files) {
    const text = read(f)!;
    const lines = text.split(/\r?\n/);
    if (Buffer.byteLength(text) > MAX_REQ_BYTES || lines.length > MAX_REQ_LINES) return { ok: false, reason: `${f} is too large (limit ${MAX_REQ_LINES} lines). ${SUPPORTED}` };
    for (const [i, line] of lines.entries()) {
      const issue = requirementIssue(line);
      if (issue) return { ok: false, reason: `${f} line ${i + 1}: ${issue}. ${SUPPORTED}` };
      if (parseRequirement(line)?.name === 'pytest') declaresPytest = true;
    }
  }
  if (!declaresPytest) return { ok: false, reason: `pytest is not declared in ${files.join(', ')}. ${SUPPORTED}` };
  return { ok: true, requirementFiles: files };
}

/** True when the repository looks like a pytest project (support is decided separately by pythonLayout). */
export function looksLikePytest(read: (path: string) => string | null): boolean {
  if (read('pytest.ini') !== null || read('conftest.py') !== null) return true;
  const pyproject = read('pyproject.toml') ?? '';
  if (/^\[tool\.pytest\.ini_options\]/m.test(pyproject)) return true;
  // pytest declared by another dependency manager (Poetry, PEP 621, Pipenv): detected, so the layout check can say why it is unsupported.
  if (/^\s*pytest\s*=|["']pytest(?:[<>=~!\s\[;][^"']*)?["']/m.test(pyproject) || /^\s*pytest\s*=/m.test(read('Pipfile') ?? '')) return true;
  if (/^\[tool:pytest\]/m.test(read('setup.cfg') ?? '') || /^\[pytest\]/m.test(read('tox.ini') ?? '')) return true;
  return REQUIREMENT_FILES.some((f) => (read(f) ?? '').split(/\r?\n/).some((l) => parseRequirement(l)?.name === 'pytest'));
}

/** Root-relative reader confined to small regular files in `dir`. */
export function fileReader(dir: string): (path: string) => string | null {
  return (path) => {
    const p = join(dir, path);
    try {
      if (!existsSync(p) || !statSync(p).isFile() || statSync(p).size > 256 * 1024) return null;
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
}

const PY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}(?:::[A-Za-z_][A-Za-z0-9_]{0,120}){0,3}(?:\[[^\]\0\n\r]{0,200}\])?$/;

/** pytest node-id tail ("test_x", "TestK::test_x[param]"). */
export function isPytestName(name: string): boolean {
  return PY_NAME.test(name);
}

function xmlDecode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Parses pytest's JUnit XML (junit_family=xunit1, which records each test's file).
 * Failed tests are reported as pytest node IDs, e.g. "tests/test_a.py::TestK::test_p[2]";
 * collection errors as "<file>: collection error".
 */
export function parsePytestJunit(file: string): TestCounts | null {
  if (!existsSync(file)) return null;
  let xml: string;
  try {
    xml = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!/<testsuites?\b/.test(xml)) return null;
  let total = 0;
  let failed = 0;
  const failedNames: string[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1];
    const body = m[3] ?? '';
    if (/<skipped\b/.test(body)) continue;
    total++;
    if (!/<(failure|error)\b/.test(body)) continue;
    failed++;
    const attr = (k: string) => {
      const v = new RegExp(`\\b${k}="([^"]*)"`).exec(attrs)?.[1];
      return v === undefined ? undefined : xmlDecode(v);
    };
    const name = attr('name') ?? '?';
    const cls = attr('classname') ?? '';
    const path = attr('file');
    if (!cls) {
      failedNames.push(`${path ?? name}: collection error`);
      continue;
    }
    const module = path?.replace(/\.py$/, '').replace(/\//g, '.');
    const inner = module && cls.startsWith(`${module}.`) ? cls.slice(module.length + 1).split('.') : [];
    failedNames.push(path ? [path, ...inner, name].join('::') : `${cls}::${name}`);
  }
  return { total, passed: total - failed, failed, failedNames };
}
