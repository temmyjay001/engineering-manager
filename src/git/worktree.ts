import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '../project';

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function branchName(key: string): string {
  return `em/${key.toLowerCase()}`;
}

export function worktreePath(project: Project, key: string): string {
  return join(project.worktreesDir, key);
}

export function scratchPath(project: Project, key: string): string {
  return join(project.scratchDir, key);
}

export function assertGitRepo(project: Project): void {
  if (!existsSync(project.root)) {
    throw new Error(`Project root does not exist: ${project.root}`);
  }
  try {
    git(project.root, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error(`Not a git repository: ${project.root}`);
  }
}

function currentBranch(repo: string): string | null {
  try {
    const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

function baseRef(project: Project): string {
  return project.config.baseBranch ?? 'HEAD';
}

export function createWorktree(project: Project, key: string): Worktree {
  mkdirSync(project.worktreesDir, { recursive: true });
  mkdirSync(scratchPath(project, key), { recursive: true });
  const path = worktreePath(project, key);
  const branch = branchName(key);
  const baseSha = git(project.root, ['rev-parse', baseRef(project)]);
  if (existsSync(path)) {
    return { path, branch, baseSha };
  }
  git(project.root, ['worktree', 'add', '-b', branch, path, baseSha]);
  return { path, branch, baseSha };
}

export function ensureWorktree(project: Project, key: string): boolean {
  const path = worktreePath(project, key);
  if (existsSync(path)) return true;
  try {
    mkdirSync(project.worktreesDir, { recursive: true });
    git(project.root, ['worktree', 'add', path, branchName(key)]);
    return true;
  } catch {
    return false;
  }
}

export interface BaseSync {
  updated: boolean;
  conflicted: boolean;
  baseSha: string;
}

export function syncWorktreeWithBase(project: Project, key: string, knownBaseSha: string): BaseSync {
  const ref = project.config.baseBranch ?? currentBranch(project.root) ?? 'HEAD';
  const latestBase = git(project.root, ['rev-parse', ref]);
  if (latestBase === knownBaseSha) return { updated: false, conflicted: false, baseSha: knownBaseSha };
  const path = worktreePath(project, key);
  try {
    git(path, ['merge', '--no-edit', latestBase]);
    return { updated: true, conflicted: false, baseSha: latestBase };
  } catch {
    try {
      git(path, ['merge', '--abort']);
    } catch {
      /* no merge in progress */
    }
    return { updated: false, conflicted: true, baseSha: knownBaseSha };
  }
}

export function removeWorktree(project: Project, key: string, opts: { deleteBranch?: boolean } = {}): void {
  const path = worktreePath(project, key);
  if (existsSync(path)) {
    git(project.root, ['worktree', 'remove', '--force', path]);
  }
  if (opts.deleteBranch ?? true) {
    try {
      git(project.root, ['branch', '-D', branchName(key)]);
    } catch {
      /* branch may not exist */
    }
  }
}

const DIFF_MAX_BUFFER = 64 * 1024 * 1024;

export function diff(project: Project, key: string, baseSha: string): string {
  const path = worktreePath(project, key);
  return execFileSync('git', ['-C', path, 'diff', baseSha], { encoding: 'utf8', maxBuffer: DIFF_MAX_BUFFER });
}

export function diffStat(project: Project, key: string, baseSha: string): string {
  return git(worktreePath(project, key), ['diff', '--stat', baseSha]);
}

export interface BaseTip {
  ref: string;
  sha: string;
}

export function resolveBase(project: Project): BaseTip | null {
  const ref = project.config.baseBranch ?? currentBranch(project.root);
  if (!ref) return null;
  try {
    return { ref, sha: git(project.root, ['rev-parse', `refs/heads/${ref}`]) };
  } catch {
    return null;
  }
}

export function squashCandidate(project: Project, key: string, parentSha: string, message: string): string {
  const tree = git(project.root, ['rev-parse', `${branchName(key)}^{tree}`]);
  return git(project.root, ['commit-tree', tree, '-p', parentSha, '-m', message]);
}

export function setPendingRef(project: Project, key: string, sha: string): void {
  git(project.root, ['update-ref', `refs/em/pending/${key.toLowerCase()}`, sha]);
}

export function clearPendingRef(project: Project, key: string): void {
  try {
    git(project.root, ['update-ref', '-d', `refs/em/pending/${key.toLowerCase()}`]);
  } catch {
    /* ref may not exist */
  }
}

export type AdvanceResult = 'ok' | 'dirty' | 'busy' | 'moved';

function checkoutPathOf(root: string, ref: string): string | null {
  const out = git(root, ['worktree', 'list', '--porcelain']);
  let path: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    if (line === `branch refs/heads/${ref}`) return path;
  }
  return null;
}

export function advanceBase(project: Project, ref: string, expectedSha: string, candidateSha: string): AdvanceResult {
  const checkout = checkoutPathOf(project.root, ref);
  if (checkout === null) {
    try {
      git(project.root, ['update-ref', `refs/heads/${ref}`, candidateSha, expectedSha]);
      return 'ok';
    } catch {
      return 'moved';
    }
  }
  if (checkout !== project.root) return 'busy';
  if (git(project.root, ['status', '--porcelain', '-uno']) !== '') return 'dirty';
  try {
    git(project.root, ['merge', '--ff-only', candidateSha]);
    return 'ok';
  } catch {
    return 'moved';
  }
}

export function commitAll(project: Project, key: string, message: string): void {
  const path = worktreePath(project, key);
  git(path, ['add', '-A']);
  try {
    git(path, ['commit', '-m', message]);
  } catch {
    /* nothing to commit */
  }
}

export function pushBranch(project: Project, key: string): void {
  git(project.root, ['push', '-u', 'origin', branchName(key)]);
}

export function createPullRequest(project: Project, key: string, title: string, body: string): string {
  return execFileSync(
    'gh',
    ['pr', 'create', '--head', branchName(key), '--title', title, '--body', body],
    { encoding: 'utf8', cwd: project.root },
  ).trim();
}
