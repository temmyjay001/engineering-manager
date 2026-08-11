import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProjectEntry, listProjects, registerProject } from '../src/registry';

let configHome: string;
let repos: string[];

function makeRepo(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `em-reg-${name}-`)));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('node', ['-e', `require('fs').mkdirSync(require('path').join(${JSON.stringify(dir)}, '.em'))`]);
  repos.push(dir);
  return dir;
}

beforeEach(() => {
  configHome = realpathSync(mkdtempSync(join(tmpdir(), 'em-cfg-')));
  process.env.XDG_CONFIG_HOME = configHome;
  repos = [];
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(configHome, { recursive: true, force: true });
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

describe('project registry', () => {
  it('registers and lists projects with stable ids and names', () => {
    const a = makeRepo('a');
    registerProject(a);
    const listed = listProjects();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.root).toBe(a);
    expect(listed[0]?.name).toBe(a.split('/').pop());
    expect(listed[0]?.id).toMatch(/^[a-f0-9]{8}$/);
    expect(findProjectEntry(listed[0]!.id)?.root).toBe(a);
  });

  it('deduplicates repeated registration of the same root', () => {
    const a = makeRepo('a');
    registerProject(a);
    registerProject(a);
    expect(listProjects()).toHaveLength(1);
  });

  it('gives distinct ids to distinct roots and keeps ids stable across calls', () => {
    const a = makeRepo('a');
    const b = makeRepo('b');
    registerProject(a);
    registerProject(b);
    const first = listProjects();
    const second = listProjects();
    expect(new Set(first.map((p) => p.id)).size).toBe(2);
    expect(first.map((p) => p.id)).toEqual(second.map((p) => p.id));
  });

  it('omits registered roots whose .em directory no longer exists', () => {
    const a = makeRepo('a');
    registerProject(a);
    rmSync(join(a, '.em'), { recursive: true, force: true });
    expect(listProjects()).toHaveLength(0);
  });

  it('returns undefined for an unknown id', () => {
    expect(findProjectEntry('deadbeef')).toBeUndefined();
  });
});
