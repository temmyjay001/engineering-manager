import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceBase,
  createWorktree,
  ensureWorktree,
  resolveBase,
  squashCandidate,
  syncWorktreeWithBase,
  worktreePath,
} from '../src/git/worktree';
import { initProject, type Project } from '../src/project';

let dir: string;
let project: Project;

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commitFile(repo: string, name: string, content: string, message: string): void {
  writeFileSync(join(repo, name), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
}

beforeEach(() => {
  delete process.env.EM_TARGET_REPO;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'em-worktree-')));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, ['config', 'user.email', 'em@test']);
  git(dir, ['config', 'user.name', 'em']);
  commitFile(dir, 'README.md', 'hello\n', 'initial');
  project = initProject(dir).project;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('base drift', () => {
  it('reports no-op when the base has not moved', () => {
    const wt = createWorktree(project, 'EM-1');
    const sync = syncWorktreeWithBase(project, 'EM-1', wt.baseSha);
    expect(sync).toEqual({ updated: false, conflicted: false, baseSha: wt.baseSha });
  });

  it('merges an advanced base into the worktree', () => {
    const wt = createWorktree(project, 'EM-1');
    commitFile(dir, 'later.txt', 'landed after the worktree\n', 'advance base');
    const newBase = git(dir, ['rev-parse', 'HEAD']);

    const sync = syncWorktreeWithBase(project, 'EM-1', wt.baseSha);
    expect(sync.updated).toBe(true);
    expect(sync.conflicted).toBe(false);
    expect(sync.baseSha).toBe(newBase);
    expect(readFileSync(join(worktreePath(project, 'EM-1'), 'later.txt'), 'utf8')).toContain('landed');
  });

  it('aborts cleanly and keeps the old base on conflict', () => {
    const wt = createWorktree(project, 'EM-1');
    const wtPath = worktreePath(project, 'EM-1');
    commitFile(wtPath, 'README.md', 'worktree version\n', 'worktree change');
    commitFile(dir, 'README.md', 'base version\n', 'conflicting base change');

    const sync = syncWorktreeWithBase(project, 'EM-1', wt.baseSha);
    expect(sync.updated).toBe(false);
    expect(sync.conflicted).toBe(true);
    expect(sync.baseSha).toBe(wt.baseSha);
    expect(git(wtPath, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(wtPath, 'README.md'), 'utf8')).toBe('worktree version\n');
  });
});

describe('squashCandidate and advanceBase on the checked-out branch', () => {
  it('lands the ticket branch as a single fast-forwarded commit on main', () => {
    const wt = createWorktree(project, 'EM-5');
    commitFile(worktreePath(project, 'EM-5'), 'feature.txt', 'done\n', 'feature work');
    commitFile(worktreePath(project, 'EM-5'), 'feature.txt', 'done again\n', 'stray test commit');

    const base = resolveBase(project)!;
    const candidate = squashCandidate(project, 'EM-5', base.sha, 'EM-5: Ship the feature');
    expect(advanceBase(project, base.ref, base.sha, candidate)).toBe('ok');

    expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(dir, ['log', '--format=%s', 'main'])).toBe('EM-5: Ship the feature\ninitial');
    expect(readFileSync(join(dir, 'feature.txt'), 'utf8')).toBe('done again\n');
    expect(git(dir, ['rev-parse', 'main^'])).toBe(wt.baseSha);
  });

  it('refuses to advance a dirty checkout', () => {
    createWorktree(project, 'EM-6');
    commitFile(worktreePath(project, 'EM-6'), 'feature.txt', 'done\n', 'feature work');
    writeFileSync(join(dir, 'README.md'), 'uncommitted local edit\n');

    const base = resolveBase(project)!;
    const candidate = squashCandidate(project, 'EM-6', base.sha, 'EM-6: Ship');
    expect(advanceBase(project, base.ref, base.sha, candidate)).toBe('dirty');
    expect(git(dir, ['rev-parse', 'main'])).toBe(base.sha);
  });

  it('reports moved when the base advanced under the candidate', () => {
    createWorktree(project, 'EM-7');
    commitFile(worktreePath(project, 'EM-7'), 'feature.txt', 'done\n', 'feature work');
    const base = resolveBase(project)!;
    const candidate = squashCandidate(project, 'EM-7', base.sha, 'EM-7: Ship');
    commitFile(dir, 'other.txt', 'raced in\n', 'base moves');

    expect(advanceBase(project, base.ref, base.sha, candidate)).toBe('moved');
  });
});

describe('baseBranch', () => {
  it('bases new worktrees on the configured branch', () => {
    git(dir, ['branch', 'develop']);
    commitFile(dir, 'main-only.txt', 'x\n', 'main moves ahead');
    project.config.baseBranch = 'develop';

    const wt = createWorktree(project, 'EM-2');
    expect(wt.baseSha).toBe(git(dir, ['rev-parse', 'develop']));
    expect(wt.baseSha).not.toBe(git(dir, ['rev-parse', 'main']));
  });

  it('advances a non-checked-out base branch by compare-and-swap without touching the checkout', () => {
    git(dir, ['branch', 'develop']);
    project.config.baseBranch = 'develop';

    createWorktree(project, 'EM-3');
    commitFile(worktreePath(project, 'EM-3'), 'feature.txt', 'done\n', 'feature work');
    commitFile(worktreePath(project, 'EM-3'), 'feature.txt', 'done again\n', 'stray test commit');

    const base = resolveBase(project)!;
    expect(base.ref).toBe('develop');
    const candidate = squashCandidate(project, 'EM-3', base.sha, 'EM-3: Ship the feature');
    expect(advanceBase(project, 'develop', base.sha, candidate)).toBe('ok');

    expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(dir, ['log', '--format=%s', 'develop'])).toBe('EM-3: Ship the feature\ninitial');
    expect(git(dir, ['show', 'develop:feature.txt'])).toBe('done again');
    expect(git(dir, ['rev-parse', 'develop^'])).toBe(base.sha);
  });

  it('reports busy when the base branch is checked out in another worktree', () => {
    git(dir, ['branch', 'develop']);
    git(dir, ['worktree', 'add', join(dir, '.dev-checkout'), 'develop']);
    project.config.baseBranch = 'develop';

    createWorktree(project, 'EM-4');
    commitFile(worktreePath(project, 'EM-4'), 'feature.txt', 'done\n', 'feature work');

    const base = resolveBase(project)!;
    const candidate = squashCandidate(project, 'EM-4', base.sha, 'EM-4: Ship');
    expect(advanceBase(project, 'develop', base.sha, candidate)).toBe('busy');
  });
});

describe('ensureWorktree', () => {
  it('recreates a missing worktree from an existing branch', () => {
    createWorktree(project, 'EM-8');
    commitFile(worktreePath(project, 'EM-8'), 'feature.txt', 'done\n', 'feature work');
    git(dir, ['worktree', 'remove', '--force', worktreePath(project, 'EM-8')]);

    expect(ensureWorktree(project, 'EM-8')).toBe(true);
    expect(readFileSync(join(worktreePath(project, 'EM-8'), 'feature.txt'), 'utf8')).toBe('done\n');
  });

  it('returns false when the branch is gone too', () => {
    expect(ensureWorktree(project, 'EM-9')).toBe(false);
  });
});
