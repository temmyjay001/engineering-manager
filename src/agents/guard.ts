import { execFileSync } from 'node:child_process';

function gitStatus(cwd: string): string[] | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

export type TreeSnapshot = Set<string> | null;

export function snapshotTree(cwd: string): TreeSnapshot {
  const status = gitStatus(cwd);
  return status ? new Set(status) : null;
}

export function treeChanges(cwd: string, before: TreeSnapshot): string[] {
  if (before === null) return [];
  const after = gitStatus(cwd);
  if (after === null) return [];
  return after.filter((line) => !before.has(line)).map((line) => line.slice(3));
}
