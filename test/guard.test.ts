import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotTree, treeChanges } from '../src/agents/guard';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'em-guard-')));
  execFileSync('git', ['init', '-q', dir]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('read-only tree guard', () => {
  it('reports no changes for an untouched tree', () => {
    const before = snapshotTree(dir);
    expect(treeChanges(dir, before)).toEqual([]);
  });

  it('detects files created after the snapshot', () => {
    const before = snapshotTree(dir);
    writeFileSync(join(dir, 'sneaky.txt'), 'edit from a read-only role');
    expect(treeChanges(dir, before)).toEqual(['sneaky.txt']);
  });

  it('ignores files that were already dirty before the run', () => {
    writeFileSync(join(dir, 'existing.txt'), 'already dirty');
    const before = snapshotTree(dir);
    expect(treeChanges(dir, before)).toEqual([]);
    writeFileSync(join(dir, 'new.txt'), 'new');
    expect(treeChanges(dir, before)).toEqual(['new.txt']);
  });

  it('degrades to no-op outside a git repository', () => {
    const bare = mkdtempSync(join(tmpdir(), 'em-nogit-'));
    try {
      const before = snapshotTree(bare);
      expect(before).toBeNull();
      expect(treeChanges(bare, before)).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
