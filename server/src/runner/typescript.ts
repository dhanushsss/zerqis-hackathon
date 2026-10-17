/**
 * TypeScript policy for Jest projects. TypeScript runs through the existing Jest
 * adapter (same image, same `npm ci --ignore-scripts` install); this module only
 * decides whether a checkout is a conventional, single-package TypeScript project
 * and how its type check is invoked. Bundlers, monorepos, project references,
 * and ESM-only setups are reported as unsupported rather than guessed at.
 */

export type TsCheck = 'typecheck' | 'build';

/** tsconfig files the type check may use. The build config is used only when it exists. */
export const TSCONFIG: Record<TsCheck, string> = { typecheck: 'tsconfig.json', build: 'tsconfig.build.json' };

export type TsLayout = { ok: true; checks: TsCheck[]; transform: 'ts-jest' | 'babel' } | { ok: false; reason: string };

const SUPPORTED =
  'Supported: a single-package npm project with tsconfig.json and typescript at the root, tests run by Jest through ts-jest or babel-jest with @babel/preset-typescript.';

export function isTypeScriptProject(read: (path: string) => string | null): boolean {
  return read('tsconfig.json') !== null;
}

/** Removes // and /* *\/ comments and trailing commas so a tsconfig can be read as JSON. */
export function parseJsonc(text: string): any | null {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/** Decides whether a TypeScript checkout can be installed and tested. `read` returns a root-relative file's text, or null. */
export function tsLayout(read: (path: string) => string | null): TsLayout {
  const pkgText = read('package.json');
  if (pkgText === null) return { ok: false, reason: `tsconfig.json is present but package.json is missing. ${SUPPORTED}` };
  let pkg: any;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return { ok: false, reason: `package.json is not valid JSON. ${SUPPORTED}` };
  }
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const monorepo =
    pkg.workspaces ? 'npm/yarn workspaces (package.json "workspaces")'
    : read('pnpm-workspace.yaml') !== null ? 'pnpm workspaces'
    : read('lerna.json') !== null ? 'Lerna'
    : read('nx.json') !== null ? 'Nx'
    : read('turbo.json') !== null ? 'Turborepo'
    : read('rush.json') !== null ? 'Rush'
    : null;
  if (monorepo) return { ok: false, reason: `Monorepos are not supported (${monorepo}). ${SUPPORTED}` };
  if (pkg.type === 'module') return { ok: false, reason: `ESM-only packages ("type": "module") are not supported for TypeScript yet. ${SUPPORTED}` };
  if (!deps.typescript) return { ok: false, reason: `tsconfig.json is present but typescript is not a declared dependency, so the type check cannot run offline. ${SUPPORTED}` };
  if (!deps.jest) return { ok: false, reason: `The tests are not run by Jest. ${SUPPORTED}` };

  const tsconfig = parseJsonc(read('tsconfig.json') ?? '');
  if (!tsconfig) return { ok: false, reason: `tsconfig.json could not be parsed. ${SUPPORTED}` };
  if (Array.isArray(tsconfig.references) && tsconfig.references.length) {
    return { ok: false, reason: `Project references (tsconfig "references", tsc --build) are not supported. ${SUPPORTED}` };
  }

  const jestConfigs = ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json', 'jest.config.ts'].filter((f) => read(f) !== null);
  if (jestConfigs.length > 1) return { ok: false, reason: `More than one Jest config file (${jestConfigs.join(', ')}). ${SUPPORTED}` };
  if (jestConfigs[0] === 'jest.config.ts' && !deps['ts-node']) {
    return { ok: false, reason: `jest.config.ts needs ts-node, which is not a declared dependency. ${SUPPORTED}` };
  }
  const jestText = `${jestConfigs[0] ? read(jestConfigs[0]) : ''}\n${pkg.jest ? JSON.stringify(pkg.jest) : ''}`;
  const babelText = ['babel.config.js', 'babel.config.cjs', 'babel.config.json', '.babelrc', '.babelrc.json'].map((f) => read(f) ?? '').join('\n') + (pkg.babel ? JSON.stringify(pkg.babel) : '');
  let transform: 'ts-jest' | 'babel' | null = null;
  if (/ts-jest/.test(jestText) && deps['ts-jest']) transform = 'ts-jest';
  else if (/@babel\/preset-typescript|preset-typescript/.test(babelText) && deps['@babel/preset-typescript'] && (deps['babel-jest'] || deps.jest)) transform = 'babel';
  if (!transform) {
    return { ok: false, reason: `Jest is not configured to compile TypeScript (no ts-jest preset or transform, and no Babel config with @babel/preset-typescript). ${SUPPORTED}` };
  }
  const checks: TsCheck[] = ['typecheck'];
  if (read(TSCONFIG.build) !== null) checks.push('build');
  return { ok: true, checks, transform };
}

/** One tsc diagnostic: "src/a.ts(3,5): error TS2322: …" (--pretty false) or "src/a.ts:3:5 - error TS2322: …". */
export const TSC_LINE = /^((?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.(?:[cm]?tsx?|d\.ts))(?:\((\d+),(\d+)\)|:(\d+):(\d+)\s+-)\s*:?\s*error (TS\d{3,5}):\s*(.+)$/;

export interface TscDiagnostic {
  file: string;
  line: number;
  code: string;
  message: string;
}

export function parseTscOutput(output: string): TscDiagnostic[] {
  const out: TscDiagnostic[] = [];
  for (const raw of output.split('\n')) {
    const m = TSC_LINE.exec(raw.trim());
    if (!m) continue;
    out.push({ file: m[1], line: Number(m[2] ?? m[4]), code: m[6], message: m[7].trim() });
  }
  return out;
}
