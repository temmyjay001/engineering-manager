import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx';
import { Store } from '../src/db/store';
import { stepOnce } from '../src/orchestrator/orchestrator';
import { parseEmConfig, type EmConfig, type Project } from '../src/project';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-approval-'));
  store = new Store(join(dir, 'eng.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function configWith(overrides: Partial<EmConfig>): EmConfig {
  const parsed = parseEmConfig(overrides);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.config;
}

function ctxWith(approvalMode: EmConfig['approvalMode']): Ctx {
  const project: Project = {
    root: dir,
    emDir: join(dir, '.em'),
    dbPath: join(dir, 'eng.db'),
    worktreesDir: join(dir, '.em', 'worktrees'),
    scratchDir: join(dir, '.em', 'scratch'),
    configPath: join(dir, '.em', 'config.json'),
    config: configWith({ approvalMode }),
  };
  return { store, project };
}

function awaitingTicket(epicId: number | null = null): number {
  const seq = epicId === null ? {} : { epicId, seq: 1 };
  const t = store.createTicket({ title: 't', description: 'd', ...seq });
  store.transition({ ticketId: t.id, from: 'BACKLOG', to: 'AWAIT_APPROVAL', role: 'pm', verdict: 'PASS', note: null });
  return t.id;
}

describe('approvalMode', () => {
  it('always: holds at AWAIT_APPROVAL for a human', async () => {
    const id = awaitingTicket();
    const res = await stepOnce(ctxWith('always'), id);
    expect(res.moved).toBe(false);
    expect(res.awaitingHuman).toBe(true);
    expect(store.getTicketById(id)?.status).toBe('AWAIT_APPROVAL');
  });

  it('never: auto-approves standalone tickets into DESIGN', async () => {
    const id = awaitingTicket();
    const res = await stepOnce(ctxWith('never'), id);
    expect(res.moved).toBe(true);
    expect(res.awaitingHuman).toBe(false);
    expect(store.getTicketById(id)?.status).toBe('DESIGN');
    const last = store.listTransitions(id).at(-1);
    expect(last?.note).toContain('auto-approved');
  });

  it('epic-once: auto-approves subtickets but not standalone tickets', async () => {
    const epic = store.createEpic({ title: 'goal', description: 'goal' });
    const subId = awaitingTicket(epic.id);
    const soloId = awaitingTicket();

    const sub = await stepOnce(ctxWith('epic-once'), subId);
    expect(sub.moved).toBe(true);
    expect(store.getTicketById(subId)?.status).toBe('DESIGN');

    const solo = await stepOnce(ctxWith('epic-once'), soloId);
    expect(solo.awaitingHuman).toBe(true);
    expect(store.getTicketById(soloId)?.status).toBe('AWAIT_APPROVAL');
  });
});

describe('ticket budget cap', () => {
  it('blocks the ticket before running an agent once spend crosses the cap', async () => {
    const ctx = ctxWith('always');
    ctx.project.config = { ...ctx.project.config, maxTicketBudgetUsd: 1 };
    const t = store.createTicket({ title: 't', description: 'd' });
    store.recordAgentRun({ ticketId: t.id, role: 'pm', status: 'OK', costUsd: 1.5, numTurns: 1, durationMs: 10 });
    const step = await stepOnce(ctx, t.id);
    expect(step.ticket.status).toBe('BLOCKED');
    expect(step.message).toContain('budget');
  });
});
