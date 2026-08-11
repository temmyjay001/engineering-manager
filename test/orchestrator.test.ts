import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentIdleTimeoutError } from '../src/agents/runner';
import type { Ctx } from '../src/ctx';
import { Store } from '../src/db/store';
import type { Ticket } from '../src/domain/types';
import { createWorktree, worktreePath } from '../src/git/worktree';
import { stepOnce } from '../src/orchestrator/orchestrator';
import { initProject } from '../src/project';

const { runDeveloper, runReviewer } = vi.hoisted(() => ({ runDeveloper: vi.fn(), runReviewer: vi.fn() }));

vi.mock('../src/agents', async () => {
  const actual = await vi.importActual<typeof import('../src/agents')>('../src/agents');
  return { ...actual, RUNNERS: { ...actual.RUNNERS, developer: runDeveloper, reviewer: runReviewer } };
});

let dir: string;
let ctx: Ctx;
let store: Store;

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commitFile(repo: string, name: string, content: string, message: string): void {
  writeFileSync(join(repo, name), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
}

function readyTicket(): Ticket {
  const t = store.createTicket({ title: 'idle watchdog rework', description: 'test' });
  const wt = createWorktree(ctx.project, t.key);
  store.setWorktree(t.id, wt.branch, wt.baseSha);
  store.transition({ ticketId: t.id, from: 'BACKLOG', to: 'READY', role: 'pm', verdict: 'PASS', note: 'test' });
  return store.getTicketById(t.id)!;
}

function inReviewTicket(priorFailedAttempts = 0): Ticket {
  const ready = readyTicket();
  commitFile(worktreePath(ctx.project, ready.key), 'feature.txt', 'work\n', `${ready.key}: work`);
  let from: Ticket['status'] = 'READY';
  for (let i = 0; i < priorFailedAttempts; i++) {
    store.transition({ ticketId: ready.id, from, to: 'IN_PROGRESS', role: 'reviewer', verdict: 'FAIL', note: 'seed attempt' });
    store.transition({ ticketId: ready.id, from: 'IN_PROGRESS', to: 'IN_REVIEW', role: 'developer', verdict: 'PASS', note: 'seed', gate: 'reviewer' });
    from = 'IN_REVIEW';
  }
  if (priorFailedAttempts === 0) {
    store.transition({ ticketId: ready.id, from, to: 'IN_REVIEW', role: 'developer', verdict: 'PASS', note: 'test', gate: 'reviewer' });
  }
  return store.getTicketById(ready.id)!;
}

beforeEach(() => {
  runDeveloper.mockReset();
  runReviewer.mockReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'em-orchestrator-')));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, ['config', 'user.email', 'em@test']);
  git(dir, ['config', 'user.name', 'em']);
  commitFile(dir, 'README.md', 'hello\n', 'initial');
  const project = initProject(dir).project;
  store = new Store(project.dbPath);
  ctx = { store, project };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('stepOnce idle-timeout handling', () => {
  it('treats an AgentIdleTimeoutError like a gate FAIL: transitions back to IN_PROGRESS, increments attempt, and notes the timeout', async () => {
    const ticket = inReviewTicket();
    runReviewer.mockRejectedValue(new AgentIdleTimeoutError(15));

    const step = await stepOnce(ctx, ticket.id);

    expect(step.moved).toBe(true);
    expect(step.done).toBe(false);
    expect(step.ticket.status).toBe('IN_PROGRESS');
    expect(step.ticket.attempt).toBe(1);
    const last = store.listTransitions(ticket.id).at(-1);
    expect(last?.verdict).toBe('FAIL');
    expect(last?.note).toContain('idle timeout');
  });

  it('blocks the ticket once max attempts are exhausted by repeated idle timeouts', async () => {
    const ticket = inReviewTicket(1);
    ctx.project.config = { ...ctx.project.config, maxAttempts: 1 };
    runReviewer.mockRejectedValue(new AgentIdleTimeoutError(15));

    const step = await stepOnce(ctx, ticket.id);

    expect(step.ticket.status).toBe('BLOCKED');
    expect(step.done).toBe(true);
    const last = store.listTransitions(ticket.id).at(-1);
    expect(last?.note).toContain('idle timeout');
  });

  it('blocks the ticket immediately when the developer role itself idles out, same as any developer FAIL', async () => {
    const ticket = readyTicket();
    runDeveloper.mockRejectedValue(new AgentIdleTimeoutError(15));

    const step = await stepOnce(ctx, ticket.id);

    expect(step.ticket.status).toBe('BLOCKED');
    const last = store.listTransitions(ticket.id).at(-1);
    expect(last?.verdict).toBe('FAIL');
    expect(last?.note).toContain('idle timeout');
  });

  it('still propagates non-idle agent failures instead of swallowing them', async () => {
    const ticket = readyTicket();
    runDeveloper.mockRejectedValue(new Error('boom'));

    await expect(stepOnce(ctx, ticket.id)).rejects.toThrow('boom');
    expect(store.getTicketById(ticket.id)?.status).toBe('READY');
  });
});
