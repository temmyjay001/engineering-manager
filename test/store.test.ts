import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/store';
import type { TicketRelationType } from '../src/domain/types';

let dir: string;
let store: Store;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-store-'));
  dbPath = join(dir, 'eng.db');
  store = new Store(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('tickets', () => {
  it('assigns sequential EM keys', () => {
    const a = store.createTicket({ title: '', description: 'first' });
    const b = store.createTicket({ title: '', description: 'second' });
    expect(a.key).toBe('EM-1');
    expect(b.key).toBe('EM-2');
    expect(store.getTicketByKey('EM-2')?.description).toBe('second');
  });

  it('increments attempt only on rework transitions', () => {
    const t = store.createTicket({ title: '', description: 'x' });
    store.transition({ ticketId: t.id, from: 'IN_REVIEW', to: 'IN_PROGRESS', role: 'reviewer', verdict: 'FAIL', note: null });
    expect(store.getTicketById(t.id)?.attempt).toBe(1);
    store.transition({ ticketId: t.id, from: 'IN_PROGRESS', to: 'IN_REVIEW', role: 'developer', verdict: 'PASS', note: null });
    expect(store.getTicketById(t.id)?.attempt).toBe(1);
  });

  it('resets attempt on demand', () => {
    const t = store.createTicket({ title: '', description: 'x' });
    store.transition({ ticketId: t.id, from: 'IN_REVIEW', to: 'IN_PROGRESS', role: 'reviewer', verdict: 'FAIL', note: null });
    store.resetAttempt(t.id);
    expect(store.getTicketById(t.id)?.attempt).toBe(0);
  });

  it('sets and reads back the DRAFT status', () => {
    const t = store.createTicket({ title: '', description: 'x' });
    store.transition({ ticketId: t.id, from: 'BACKLOG', to: 'DRAFT', role: null, verdict: null, note: null });
    expect(store.getTicketById(t.id)?.status).toBe('DRAFT');
  });
});

describe('draft messages', () => {
  it('saves a draft message with sender, text, and timestamp', () => {
    const t = store.createTicket({ title: '', description: 'x' });
    const msg = store.addDraftMessage(t.id, 'stakeholder', 'what about auth?');
    expect(msg).toMatchObject({ ticketId: t.id, sender: 'stakeholder', text: 'what about auth?' });
    expect(msg.createdAt).toBeTruthy();
  });

  it('returns draft messages for a ticket ordered oldest first, excluding other tickets', () => {
    const a = store.createTicket({ title: '', description: 'a' });
    const b = store.createTicket({ title: '', description: 'b' });
    store.addDraftMessage(a.id, 'stakeholder', 'first');
    store.addDraftMessage(a.id, 'pm', 'second');
    store.addDraftMessage(b.id, 'stakeholder', 'other ticket');
    const messages = store.draftMessages(a.id);
    expect(messages.map((m) => m.text)).toEqual(['first', 'second']);
    expect(messages.every((m) => m.ticketId === a.id)).toBe(true);
  });
});

describe('ticket priority and labels', () => {
  it('defaults priority to medium when not specified', () => {
    const t = store.createTicket({ title: '', description: 'x' });
    expect(t.priority).toBe('medium');
    expect(store.getTicketById(t.id)?.priority).toBe('medium');
  });

  it('defaults labels to an empty list when not specified', () => {
    const t = store.createTicket({ title: '', description: 'x' });
    expect(t.labels).toEqual([]);
    expect(store.getTicketById(t.id)?.labels).toEqual([]);
  });
});

describe('ticket relations', () => {
  it('persists a blocks relation between two tickets', () => {
    const a = store.createTicket({ title: '', description: 'a' });
    const b = store.createTicket({ title: '', description: 'b' });
    const rel = store.addTicketRelation(a.id, b.id, 'blocks');
    expect(rel).toMatchObject({ ticketId: a.id, otherTicketId: b.id, relationType: 'blocks' });
    expect(store.getTicketRelations(a.id)).toHaveLength(1);
  });

  it('persists a relates-to relation between two tickets', () => {
    const a = store.createTicket({ title: '', description: 'a' });
    const b = store.createTicket({ title: '', description: 'b' });
    const rel = store.addTicketRelation(a.id, b.id, 'relates-to');
    expect(rel).toMatchObject({ ticketId: a.id, otherTicketId: b.id, relationType: 'relates-to' });
    expect(store.getTicketRelations(a.id)).toHaveLength(1);
  });

  it('rejects an invalid relation type and stores nothing', () => {
    const a = store.createTicket({ title: '', description: 'a' });
    const b = store.createTicket({ title: '', description: 'b' });
    expect(() => store.addTicketRelation(a.id, b.id, 'duplicates' as TicketRelationType)).toThrow();
    expect(store.getTicketRelations(a.id)).toHaveLength(0);
  });
});

describe('criteria', () => {
  it('replaces criteria wholesale and records results', () => {
    const t = store.createTicket({ title: '', description: 'x' });
    store.setCriteria(t.id, [
      { text: 'a', isUi: false },
      { text: 'b', isUi: true },
    ]);
    store.setCriteria(t.id, [{ text: 'c', isUi: false }]);
    const cs = store.getCriteria(t.id);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ idx: 1, text: 'c', met: false });
    store.setCriteriaResults(t.id, [{ idx: 1, met: true }]);
    expect(store.getCriteria(t.id)[0]?.met).toBe(true);
  });
});

describe('artifacts', () => {
  it('versions artifacts per kind and stores structured data', () => {
    const t = store.createTicket({ title: '', description: 'x' });
    store.addArtifact(t.id, 'REVIEW', 'reviewer', 'first review', { verdict: 'FAIL' });
    const second = store.addArtifact(t.id, 'REVIEW', 'reviewer', 'second review');
    const diff = store.addArtifact(t.id, 'DIFF', 'developer', 'diff body');
    expect(second.version).toBe(2);
    expect(diff.version).toBe(1);
    const latest = store.latestArtifact(t.id, 'REVIEW');
    expect(latest?.content).toBe('second review');
    const first = store.getArtifacts(t.id)[0]!;
    expect(JSON.parse(first.data!)).toEqual({ verdict: 'FAIL' });
  });

  it('accepts human guidance artifacts', () => {
    const t = store.createTicket({ title: '', description: 'x' });
    const g = store.addArtifact(t.id, 'GUIDANCE', 'human', 'use the existing middleware');
    expect(g.role).toBe('human');
    expect(g.kind).toBe('GUIDANCE');
  });
});

describe('epics', () => {
  it('stores the planner output as structured subtickets', () => {
    const e = store.createEpic({ title: 'goal', description: 'goal' });
    store.setEpicPlan(e.id, 'narrative', [
      { title: 'one', description: 'do one', dependsOn: [] },
      { title: 'two', description: 'do two', dependsOn: [1] },
    ]);
    expect(store.plannedSubtickets(e.id)).toHaveLength(2);
    expect(store.getEpicById(e.id)?.plan).toBe('narrative');
  });

  it('round-trips subticket dependencies', () => {
    const e = store.createEpic({ title: 'goal', description: 'goal' });
    const a = store.createTicket({ title: 'a', description: 'a', epicId: e.id, seq: 1 });
    const b = store.createTicket({ title: 'b', description: 'b', epicId: e.id, seq: 2, dependsOn: [1] });
    expect(store.getTicketById(a.id)?.dependsOn).toEqual([]);
    expect(store.getTicketById(b.id)?.dependsOn).toEqual([1]);
  });

  it('returns null planned subtickets when no plan exists', () => {
    const e = store.createEpic({ title: 'goal', description: 'goal' });
    expect(store.plannedSubtickets(e.id)).toBeNull();
  });
});

describe('key prefixes', () => {
  it('generates ticket and epic keys from configured prefixes', () => {
    const custom = new Store(join(dir, 'custom.db'), { ticketPrefix: 'APP', epicPrefix: 'BIG' });
    try {
      expect(custom.createTicket({ title: '', description: 'x' }).key).toBe('APP-1');
      expect(custom.createTicket({ title: '', description: 'y' }).key).toBe('APP-2');
      expect(custom.createEpic({ title: 'g', description: 'g' }).key).toBe('BIG-1');
      expect(custom.getTicketByKey('APP-2')?.description).toBe('y');
    } finally {
      custom.close();
    }
  });

  it('defaults to EM and EP', () => {
    expect(store.createTicket({ title: '', description: 'x' }).key).toBe('EM-1');
    expect(store.createEpic({ title: 'g', description: 'g' }).key).toBe('EP-1');
  });
});

describe('run locks', () => {
  it('grants one active run per target', () => {
    const first = store.startRun('ticket:EM-1');
    expect(first).not.toBeNull();
    expect(store.startRun('ticket:EM-1')).toBeNull();
    expect(store.startRun('ticket:EM-2')).not.toBeNull();
    store.finishRun(first!.id, 'OK');
    expect(store.startRun('ticket:EM-1')).not.toBeNull();
  });

  it('takes over a lock whose owning process died', () => {
    const raw = new Database(dbPath);
    raw.prepare(`INSERT INTO runs (target, pid) VALUES ('ticket:EM-9', 999999)`).run();
    raw.close();
    const taken = store.startRun('ticket:EM-9');
    expect(taken).not.toBeNull();
    expect(taken?.pid).toBe(process.pid);
  });

  it('persists and pages run logs', () => {
    const run = store.startRun('epic:EP-1')!;
    store.appendRunLog(run.id, 'line one');
    store.appendRunLog(run.id, 'line two');
    const all = store.getRunLogs(run.id);
    expect(all.map((l) => l.line)).toEqual(['line one', 'line two']);
    const after = store.getRunLogs(run.id, all[0]!.id);
    expect(after.map((l) => l.line)).toEqual(['line two']);
  });

  it('returns the latest run for a target across finishes', () => {
    const first = store.startRun('ticket:EM-1')!;
    store.finishRun(first.id, 'OK');
    const second = store.startRun('ticket:EM-1')!;
    expect(store.latestRun('ticket:EM-1')?.id).toBe(second.id);
    expect(store.latestRun('ticket:EM-9')).toBeUndefined();
  });

  it('flags and reports cancellation on the active run only', () => {
    const run = store.startRun('ticket:EM-1')!;
    expect(store.isCancelRequested(run.id)).toBe(false);
    expect(store.requestCancel('ticket:EM-1')).toBe(true);
    expect(store.isCancelRequested(run.id)).toBe(true);
    store.finishRun(run.id, 'CANCELLED', 'cancelled by request');
    expect(store.requestCancel('ticket:EM-1')).toBe(false);
    expect(store.getRun(run.id)?.status).toBe('CANCELLED');
  });

  it('sweeps active runs whose owning process is dead and marks them interrupted', () => {
    const raw = new Database(dbPath);
    raw.prepare(`INSERT INTO runs (target, pid) VALUES ('ticket:EM-9', 999999)`).run();
    raw.close();
    const alive = store.startRun('ticket:EM-1')!;

    const reaped = store.sweepDeadRuns();

    expect(reaped).toEqual(['ticket:EM-9']);
    const dead = store.latestRun('ticket:EM-9');
    expect(dead?.status).toBe('ERROR');
    expect(dead?.error).toBe('interrupted: owning process gone');
    expect(dead?.finishedAt).not.toBeNull();
    expect(store.getRun(alive.id)?.status).toBe('RUNNING');
  });

  it('does not sweep runs whose owning process is still alive', () => {
    store.startRun('ticket:EM-1');
    expect(store.sweepDeadRuns()).toEqual([]);
  });

  it('reports interrupted targets until a new run supersedes them', () => {
    const raw = new Database(dbPath);
    raw.prepare(`INSERT INTO runs (target, pid) VALUES ('ticket:EM-9', 999999)`).run();
    raw.close();
    expect(store.interruptedTargets()).toEqual([]);

    store.sweepDeadRuns();
    expect(store.interruptedTargets()).toEqual(['ticket:EM-9']);

    const resumed = store.startRun('ticket:EM-9')!;
    expect(store.interruptedTargets()).toEqual([]);
    store.finishRun(resumed.id, 'OK');
    expect(store.interruptedTargets()).toEqual([]);
  });
});

describe('revision', () => {
  it('changes when tickets, transitions, epics, or runs change', () => {
    const base = store.revision();
    const t = store.createTicket({ title: '', description: 'x' });
    const afterTicket = store.revision();
    expect(afterTicket).not.toBe(base);

    store.transition({ ticketId: t.id, from: 'BACKLOG', to: 'AWAIT_APPROVAL', role: 'pm', verdict: 'PASS', note: null });
    const afterTransition = store.revision();
    expect(afterTransition).not.toBe(afterTicket);

    const run = store.startRun('ticket:EM-1')!;
    store.finishRun(run.id, 'OK');
    expect(store.revision()).not.toBe(afterTransition);
  });

  it('is stable when nothing changes', () => {
    store.createTicket({ title: '', description: 'x' });
    expect(store.revision()).toBe(store.revision());
  });
});

describe('agent runs', () => {
  it('records runner, model, and token counts', () => {
    const t = store.createTicket({ title: '', description: 'x' });
    store.recordAgentRun({
      ticketId: t.id,
      role: 'developer',
      runner: 'codex',
      model: 'gpt-5.1-codex-mini',
      status: 'OK',
      costUsd: 0.12,
      numTurns: 0,
      durationMs: 4200,
      inputTokens: 13411,
      outputTokens: 30,
    });
    const [run] = store.agentRunsForTicket(t.id);
    expect(run).toMatchObject({
      runner: 'codex',
      model: 'gpt-5.1-codex-mini',
      inputTokens: 13411,
      outputTokens: 30,
    });
  });

  it('records cost and aggregates per ticket and epic', () => {
    const e = store.createEpic({ title: 'goal', description: 'goal' });
    const t = store.createTicket({ title: '', description: 'x', epicId: e.id, seq: 1 });
    store.recordAgentRun({ epicId: e.id, role: 'planner', status: 'OK', costUsd: 1.5, numTurns: 10, durationMs: 1000 });
    store.recordAgentRun({ ticketId: t.id, role: 'developer', status: 'OK', costUsd: 2.25, numTurns: 40, durationMs: 5000 });
    store.recordAgentRun({ ticketId: t.id, role: 'uat', status: 'ERROR', costUsd: 0, numTurns: 0, durationMs: 100, error: 'boom' });
    expect(store.ticketCostUsd(t.id)).toBeCloseTo(2.25);
    expect(store.epicCostUsd(e.id)).toBeCloseTo(3.75);
    expect(store.agentRunsForTicket(t.id)).toHaveLength(2);
    expect(store.agentRunsForEpic(e.id)).toHaveLength(1);
  });

  it('aggregates agent time per ticket and epic', () => {
    const e = store.createEpic({ title: 'goal', description: 'goal' });
    const t = store.createTicket({ title: '', description: 'x', epicId: e.id, seq: 1 });
    store.recordAgentRun({ epicId: e.id, role: 'planner', status: 'OK', costUsd: 0, numTurns: 1, durationMs: 1000 });
    store.recordAgentRun({ ticketId: t.id, role: 'developer', status: 'OK', costUsd: 0, numTurns: 1, durationMs: 5000 });
    store.recordAgentRun({ ticketId: t.id, role: 'uat', status: 'ERROR', costUsd: 0, numTurns: 0, durationMs: 100 });
    expect(store.ticketAgentTimeMs(t.id)).toBe(5100);
    expect(store.epicAgentTimeMs(e.id)).toBe(6100);
    expect(store.ticketAgentTimeMs(999)).toBe(0);
  });
});

describe('agent slots', () => {
  it('enforces the limit, releases, and reaps dead holders', () => {
    const a = store.acquireSlot('agent', 2);
    const b = store.acquireSlot('agent', 2);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(store.acquireSlot('agent', 2)).toBeNull();
    store.releaseSlot(a!);
    expect(store.acquireSlot('agent', 2)).not.toBeNull();

    expect(store.acquireSlot('browser', 1)).not.toBeNull();
    expect(store.acquireSlot('browser', 1)).toBeNull();
  });
});
