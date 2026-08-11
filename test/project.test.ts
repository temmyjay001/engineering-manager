import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProjectRoot, initProject, openProject, parseEmConfig, projectAt, saveConfig } from '../src/project';

let dir: string;

beforeEach(() => {
  delete process.env.EM_TARGET_REPO;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'em-project-')));
  execFileSync('git', ['init', '-q', dir]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('project discovery', () => {
  it('falls back to the git toplevel when no .em exists', () => {
    const nested = join(dir, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(realpathSync(findProjectRoot(nested)!)).toBe(dir);
  });

  it('finds the nearest ancestor with a .em directory', () => {
    projectAt(dir);
    const nested = join(dir, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(dir);
  });

  it('honors EM_TARGET_REPO as an override', () => {
    process.env.EM_TARGET_REPO = dir;
    expect(findProjectRoot('/somewhere/else')).toBe(dir);
  });

  it('returns null outside any git repo', () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'em-nogit-')));
    try {
      expect(findProjectRoot(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('project layout', () => {
  it('creates .em with a gitignore and default config', () => {
    const { project, created } = initProject(dir);
    expect(created).toBe(true);
    expect(existsSync(project.configPath)).toBe(true);
    expect(readFileSync(join(project.emDir, '.gitignore'), 'utf8')).toContain('eng.db');
    expect(project.config.mergeStrategy).toBe('merge');
    const again = initProject(dir);
    expect(again.created).toBe(false);
  });

  it('parses config overrides', () => {
    const { project } = initProject(dir);
    writeFileSync(
      project.configPath,
      JSON.stringify({ mergeStrategy: 'pr', runCommand: 'npm run dev', roles: { developer: { maxTurns: 50 } } }),
    );
    const reloaded = openProject(dir);
    expect(reloaded.config.mergeStrategy).toBe('pr');
    expect(reloaded.config.runCommand).toBe('npm run dev');
    expect(reloaded.config.roles.developer?.maxTurns).toBe(50);
  });

  it('rejects invalid config with a readable error', () => {
    const { project } = initProject(dir);
    writeFileSync(project.configPath, JSON.stringify({ mergeStrategy: 'yolo' }));
    expect(() => openProject(dir)).toThrow(/mergeStrategy/);
  });

  it('rejects malformed JSON with a readable error', () => {
    const { project } = initProject(dir);
    writeFileSync(project.configPath, '{ nope');
    expect(() => openProject(dir)).toThrow(/not valid JSON/);
  });

  it('validates and saves config updates in place', () => {
    const { project } = initProject(dir);
    const invalid = parseEmConfig({ mergeStrategy: 'yolo' });
    expect('error' in invalid && invalid.error).toMatch(/mergeStrategy/);

    const unknownKeys = parseEmConfig({ error: { bad: true } });
    expect('error' in unknownKeys).toBe(true);

    const typo = parseEmConfig({ roles: { developer: { modle: 'x' } } });
    expect('error' in typo).toBe(true);

    const valid = parseEmConfig({
      mergeStrategy: 'pr',
      roles: { developer: { runner: 'codex', model: 'gpt-5.1-codex-mini' } },
    });
    if ('error' in valid) throw new Error(valid.error);
    saveConfig(project, valid.config);
    expect(project.config.mergeStrategy).toBe('pr');
    const reloaded = openProject(dir);
    expect(reloaded.config.roles.developer?.runner).toBe('codex');
    expect(reloaded.config.runCommand).toBeNull();
  });
});

describe('launch knobs', () => {
  it('applies defaults for all eight knobs', () => {
    const { project } = initProject(dir);
    expect(project.config.ticketPrefix).toBe('EM');
    expect(project.config.epicPrefix).toBe('EP');
    expect(project.config.baseBranch).toBeNull();
    expect(project.config.maxParallelSubtickets).toBe(3);
    expect(project.config.maxAttempts).toBe(3);
    expect(project.config.approvalMode).toBe('always');
    expect(project.config.idleTimeoutMinutes).toBe(15);
    expect(project.config.autoResumeInterrupted).toBe(false);
  });

  it('allows enabling auto-resume of interrupted runs', () => {
    const parsed = parseEmConfig({ autoResumeInterrupted: true });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.config.autoResumeInterrupted).toBe(true);
  });

  it('validates prefix shape', () => {
    expect('error' in parseEmConfig({ ticketPrefix: 'em' })).toBe(true);
    expect('error' in parseEmConfig({ ticketPrefix: '1EM' })).toBe(true);
    expect('error' in parseEmConfig({ ticketPrefix: 'ABCDEFGHIJK' })).toBe(true);
    expect('error' in parseEmConfig({ epicPrefix: 'e p' })).toBe(true);
    const ok = parseEmConfig({ ticketPrefix: 'APP', epicPrefix: 'BIG' });
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.config.ticketPrefix).toBe('APP');
  });

  it('rejects identical ticket and epic prefixes', () => {
    const same = parseEmConfig({ ticketPrefix: 'X1', epicPrefix: 'X1' });
    expect('error' in same && same.error).toMatch(/must differ/);
  });

  it('bounds the numeric knobs and the approval mode', () => {
    expect('error' in parseEmConfig({ maxParallelSubtickets: 0 })).toBe(true);
    expect('error' in parseEmConfig({ maxParallelSubtickets: 9 })).toBe(true);
    expect('error' in parseEmConfig({ maxParallelSubtickets: 2.5 })).toBe(true);
    expect('error' in parseEmConfig({ maxAttempts: 0 })).toBe(true);
    expect('error' in parseEmConfig({ maxAttempts: 11 })).toBe(true);
    expect('error' in parseEmConfig({ approvalMode: 'sometimes' })).toBe(true);
    expect('error' in parseEmConfig({ idleTimeoutMinutes: 0 })).toBe(true);
    expect('error' in parseEmConfig({ idleTimeoutMinutes: -5 })).toBe(true);
    const ok = parseEmConfig({ approvalMode: 'epic-once', maxAttempts: 5, maxParallelSubtickets: 8, idleTimeoutMinutes: 30 });
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.config.approvalMode).toBe('epic-once');
    expect(ok.config.maxAttempts).toBe(5);
    expect(ok.config.idleTimeoutMinutes).toBe(30);
  });
});
