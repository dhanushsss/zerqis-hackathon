import { git } from '../runner/git.js';

export interface DependencyChange {
  ecosystem: 'npm' | 'maven';
  name: string;
  from: string | null;
  to: string | null;
  file: string;
  removedLine?: string;
  addedLine?: string;
}

export interface CommitDiff {
  files: Array<{ path: string; additions: number; deletions: number }>;
  diff: string;
  truncated: boolean;
  dependencyChanges: DependencyChange[];
  onlyDocs: boolean;
}

const DOC_FILE = /(^|\/)(README|CHANGELOG|CONTRIBUTING|LICENSE)(\.\w+)?$|\.(md|mdx|txt|rst)$|^docs\//i;

export function analyzeDiff(diff: string, numstat: string, maxChars = 24_000): CommitDiff {
  const files = numstat
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split('\t');
      return { path: p.join('\t'), additions: Number(a) || 0, deletions: Number(d) || 0 };
    });
  return {
    files,
    diff: diff.length > maxChars ? `${diff.slice(0, maxChars)}\n… [diff truncated at ${maxChars} chars]` : diff,
    truncated: diff.length > maxChars,
    dependencyChanges: dependencyChanges(diff),
    onlyDocs: files.length > 0 && files.every((f) => DOC_FILE.test(f.path)),
  };
}

/** Detects dependency version changes in package.json and pom.xml hunks. */
export function dependencyChanges(diff: string): DependencyChange[] {
  const out: DependencyChange[] = [];
  const perFile = diff.split(/^diff --git /m).slice(1);
  for (const chunk of perFile) {
    const file = /^a\/(\S+)/.exec(chunk)?.[1] ?? '';
    const removed = chunk.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const added = chunk.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    if (/(^|\/)package\.json$/.test(file)) {
      const parse = (ls: string[]) =>
        new Map(ls.map((l) => [/"([@\w./-]+)"\s*:\s*"([~^]?[\d][\w.-]*)"/.exec(l), l] as const).filter(([m]) => m).map(([m, l]) => [m![1], { v: m![2], line: l.slice(1) }] as [string, { v: string; line: string }]));
      const before = parse(removed);
      const after = parse(added);
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        if (name === 'version') continue;
        const b = before.get(name);
        const a = after.get(name);
        if (b?.v !== a?.v) out.push({ ecosystem: 'npm', name, from: b?.v ?? null, to: a?.v ?? null, file, removedLine: b?.line, addedLine: a?.line });
      }
    } else if (/(^|\/)pom\.xml$/.test(file)) {
      const prop = (ls: string[]) =>
        new Map(ls.map((l) => [/<([\w.-]+)\.version>([^<]+)<\//.exec(l), l] as const).filter(([m]) => m).map(([m, l]) => [m![1], { v: m![2].trim(), line: l.slice(1) }] as [string, { v: string; line: string }]));
      const before = prop(removed);
      const after = prop(added);
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        const b = before.get(name);
        const a = after.get(name);
        if (b?.v !== a?.v) out.push({ ecosystem: 'maven', name, from: b?.v ?? null, to: a?.v ?? null, file, removedLine: b?.line, addedLine: a?.line });
      }
      const ver = (ls: string[]) => ls.map((l) => /<version>([^<$]+)<\/version>/.exec(l)?.[1]).filter(Boolean) as string[];
      const b = ver(removed);
      const a = ver(added);
      if (b.length === 1 && a.length === 1 && b[0] !== a[0] && !before.size) {
        const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(chunk)?.[1] ?? 'unknown';
        out.push({ ecosystem: 'maven', name: artifact, from: b[0], to: a[0], file });
      }
    }
  }
  return out;
}

export async function commitDiff(repoDir: string, parent: string, sha: string): Promise<CommitDiff> {
  const [diff, numstat] = await Promise.all([
    git(['diff', '--no-color', '--no-ext-diff', '-U3', parent, sha], { cwd: repoDir }),
    git(['diff', '--numstat', parent, sha], { cwd: repoDir }),
  ]);
  return analyzeDiff(diff, numstat);
}
