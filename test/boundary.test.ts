import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { boundaryDecision, boundaryGuard } from '../src/agents/runner';

const here = dirname(fileURLToPath(import.meta.url));

const cwd = '/work/worktrees/EM-1';
const scratch = '/work/.em/scratch/EM-1';
const allowed = [cwd, scratch, tmpdir()];

describe('boundaryDecision', () => {
  it('allows writes inside the worktree', () => {
    expect(boundaryDecision(cwd, allowed, 'Write', { file_path: 'src/foo.ts' }).behavior).toBe('allow');
    expect(boundaryDecision(cwd, allowed, 'Write', { file_path: `${cwd}/src/foo.ts` }).behavior).toBe('allow');
  });

  it('allows writes to the scratch and tmp directories', () => {
    expect(boundaryDecision(cwd, allowed, 'Write', { file_path: `${scratch}/notes.md` }).behavior).toBe('allow');
    expect(boundaryDecision(cwd, allowed, 'Write', { file_path: join(tmpdir(), 'x.log') }).behavior).toBe('allow');
  });

  it('denies absolute writes outside the workspace', () => {
    const decision = boundaryDecision(cwd, allowed, 'Write', { file_path: '/etc/passwd' });
    expect(decision.behavior).toBe('deny');
    expect(decision.path).toBe('/etc/passwd');
  });

  it('denies relative escapes out of the worktree', () => {
    expect(boundaryDecision(cwd, allowed, 'Edit', { file_path: '../../../../etc/hosts' }).behavior).toBe('deny');
    expect(boundaryDecision(cwd, allowed, 'Write', { file_path: '../EM-2/sneak.ts' }).behavior).toBe('deny');
  });

  it('honors the SDK blockedPath signal for Bash and other tools', () => {
    const decision = boundaryDecision(cwd, allowed, 'Bash', {}, '/Users/someone/.aws/credentials');
    expect(decision.behavior).toBe('deny');
    expect(decision.path).toBe('/Users/someone/.aws/credentials');
  });

  it('allows non-path tools with no blockedPath', () => {
    expect(boundaryDecision(cwd, allowed, 'Bash', { command: 'ls' }).behavior).toBe('allow');
    expect(boundaryDecision(cwd, allowed, 'Read', { file_path: '/anywhere/readonly.txt' }).behavior).toBe('allow');
  });

  it('covers NotebookEdit path input', () => {
    expect(boundaryDecision(cwd, allowed, 'NotebookEdit', { notebook_path: '/tmp2/out.ipynb' }).behavior).toBe('deny');
  });

  it('leaves Read, Grep, and Glob unrestricted by default, for non-gate roles like developer', () => {
    expect(boundaryDecision(cwd, allowed, 'Read', { file_path: '/anywhere/readonly.txt' }).behavior).toBe('allow');
    expect(boundaryDecision(cwd, allowed, 'Grep', { pattern: 'foo', path: '/anywhere' }).behavior).toBe('allow');
    expect(boundaryDecision(cwd, allowed, 'Glob', { pattern: '**/*.ts', path: '/anywhere' }).behavior).toBe('allow');
  });

  it('denies Read, Grep, and Glob outside the worktree when confineReads is set, for gate roles', () => {
    expect(boundaryDecision(cwd, allowed, 'Read', { file_path: '/anywhere/readonly.txt' }, undefined, true).behavior).toBe('deny');
    expect(boundaryDecision(cwd, allowed, 'Grep', { pattern: 'foo', path: '/anywhere' }, undefined, true).behavior).toBe('deny');
    expect(boundaryDecision(cwd, allowed, 'Glob', { pattern: '**/*.ts', path: '/anywhere' }, undefined, true).behavior).toBe('deny');
  });

  it('still allows Read, Grep, and Glob inside the worktree, scratch, or tmp dirs when confineReads is set', () => {
    expect(boundaryDecision(cwd, allowed, 'Read', { file_path: `${cwd}/src/foo.ts` }, undefined, true).behavior).toBe('allow');
    expect(boundaryDecision(cwd, allowed, 'Grep', { pattern: 'foo', path: scratch }, undefined, true).behavior).toBe('allow');
    expect(boundaryDecision(cwd, allowed, 'Glob', { pattern: '**/*.ts' }, undefined, true).behavior).toBe('allow');
  });

  it('denies relative Read/Grep/Glob escapes out of the worktree when confineReads is set', () => {
    expect(boundaryDecision(cwd, allowed, 'Read', { file_path: '../EM-2/ticket.md' }, undefined, true).behavior).toBe('deny');
    expect(boundaryDecision(cwd, allowed, 'Grep', { pattern: 'foo', path: '../EM-2' }, undefined, true).behavior).toBe('deny');
  });
});

describe('read isolation for gate roles (reviewer, uat, custom gates)', () => {
  let parentCheckout: string;
  let worktree: string;

  afterEach(() => {
    rmSync(parentCheckout, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('blocks a reviewer from reading the parent checkout copy of a file that differs from its worktree copy', async () => {
    // The parent checkout must live outside the OS tmp dir: tmpdir() is itself an always-allowed
    // scratch location, so nesting the fixture there would pass the test for the wrong reason.
    parentCheckout = mkdtempSync(join(here, 'em-parent-checkout-'));
    worktree = mkdtempSync(join(tmpdir(), 'em-worktree-'));

    const parentTicketFile = join(parentCheckout, 'TICKET.md');
    const worktreeTicketFile = join(worktree, 'TICKET.md');
    writeFileSync(parentTicketFile, 'STALE: acceptance criteria v1\n');
    writeFileSync(worktreeTicketFile, 'CURRENT: acceptance criteria v2\n');
    expect(readFileSync(parentTicketFile, 'utf8')).not.toBe(readFileSync(worktreeTicketFile, 'utf8'));

    const guard = boundaryGuard({
      role: 'reviewer',
      prompt: '',
      systemPrompt: '',
      cwd: worktree,
      contract: undefined as never,
      confineReads: true,
      model: 'fake-model',
      maxTurns: 10,
    });

    const options = { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'req-1' };

    const deniedRead = await guard('Read', { file_path: parentTicketFile }, options);
    expect(deniedRead?.behavior).toBe('deny');
    expect((deniedRead as { message: string }).message).toMatch(/outside your workspace/);
    expect((deniedRead as { message: string }).message).toContain(worktree);

    const deniedGrep = await guard('Grep', { pattern: 'STALE', path: parentCheckout }, options);
    expect(deniedGrep?.behavior).toBe('deny');

    const deniedGlob = await guard('Glob', { pattern: '**/*.md', path: parentCheckout }, options);
    expect(deniedGlob?.behavior).toBe('deny');

    const allowedRead = await guard('Read', { file_path: worktreeTicketFile }, options);
    expect(allowedRead?.behavior).toBe('allow');
  });
});

describe('symlink escape', () => {
  it('denies reading through a worktree symlink that points outside it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'em-outside-'));
    const cwd = mkdtempSync(join(tmpdir(), 'em-wt-'));
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(outside, join(cwd, 'link'));
    const decision = boundaryDecision(cwd, [cwd], 'Read', { file_path: join(cwd, 'link', 'secret.txt') }, undefined, true);
    expect(decision.behavior).toBe('deny');
    rmSync(outside, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
});
