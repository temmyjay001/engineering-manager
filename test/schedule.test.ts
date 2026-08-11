import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/store';
import { launchableSubtickets } from '../src/orchestrator/orchestrator';
import { openBlockerWarning, readySubtickets, validateDependencies, type DepNode } from '../src/orchestrator/schedule';

const nodes = (spec: Record<number, number[]>): DepNode[] =>
  Object.entries(spec).map(([seq, dependsOn]) => ({ seq: Number(seq), dependsOn }));

describe('validateDependencies', () => {
  it('accepts a valid DAG', () => {
    expect(() => validateDependencies(nodes({ 1: [], 2: [1], 3: [1], 4: [2, 3] }))).not.toThrow();
  });

  it('rejects a self-dependency', () => {
    expect(() => validateDependencies(nodes({ 1: [1] }))).toThrow(/depends on itself/);
  });

  it('rejects an unknown dependency', () => {
    expect(() => validateDependencies(nodes({ 1: [], 2: [9] }))).toThrow(/unknown subticket 9/);
  });

  it('detects a cycle', () => {
    expect(() => validateDependencies(nodes({ 1: [3], 2: [1], 3: [2] }))).toThrow(/cycle/);
  });
});

describe('readySubtickets', () => {
  it('starts roots with no dependencies', () => {
    const n = nodes({ 1: [], 2: [1], 3: [1] });
    expect(readySubtickets(n, new Set(), new Set())).toEqual([1]);
  });

  it('releases dependents once their deps are done, in parallel', () => {
    const n = nodes({ 1: [], 2: [1], 3: [1], 4: [2, 3] });
    const ready = readySubtickets(n, new Set([1]), new Set());
    expect(ready.sort()).toEqual([2, 3]);
    expect(readySubtickets(n, new Set([1, 2]), new Set([3]))).toEqual([]);
    expect(readySubtickets(n, new Set([1, 2, 3]), new Set())).toEqual([4]);
  });

  it('excludes already-active and already-done subtickets', () => {
    const n = nodes({ 1: [], 2: [] });
    expect(readySubtickets(n, new Set([1]), new Set([2]))).toEqual([]);
  });

  it('holds a subticket whose dependency has not completed', () => {
    const n = nodes({ 1: [], 2: [1] });
    expect(readySubtickets(n, new Set(), new Set([1]))).toEqual([]);
  });
});

describe('launchableSubtickets', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-schedule-'));
    store = new Store(join(dir, 'eng.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('excludes a subticket with an open blocker even though its own dependencies are satisfied', () => {
    const epic = store.createEpic({ title: 'goal', description: 'goal' });
    const blocker = store.createTicket({ title: 'blocker', description: 'd' });
    const sub = store.createTicket({ title: 'sub', description: 'd', epicId: epic.id, seq: 1 });
    store.addTicketRelation(blocker.id, sub.id, 'blocks');

    const launchable = launchableSubtickets(store, store.getSubtickets(epic.id), new Set());
    expect(launchable.map((t) => t.id)).toEqual([]);
  });

  it('becomes launchable once the blocker reaches DONE', () => {
    const epic = store.createEpic({ title: 'goal', description: 'goal' });
    const blocker = store.createTicket({ title: 'blocker', description: 'd' });
    const sub = store.createTicket({ title: 'sub', description: 'd', epicId: epic.id, seq: 1 });
    store.addTicketRelation(blocker.id, sub.id, 'blocks');
    expect(launchableSubtickets(store, store.getSubtickets(epic.id), new Set())).toEqual([]);

    store.transition({ ticketId: blocker.id, from: 'BACKLOG', to: 'DONE', role: null, verdict: 'PASS', note: null });

    const launchable = launchableSubtickets(store, store.getSubtickets(epic.id), new Set());
    expect(launchable.map((t) => t.id)).toEqual([sub.id]);
  });

  it('does not exclude a subticket blocked only by a relates-to relation', () => {
    const epic = store.createEpic({ title: 'goal', description: 'goal' });
    const other = store.createTicket({ title: 'other', description: 'd' });
    const sub = store.createTicket({ title: 'sub', description: 'd', epicId: epic.id, seq: 1 });
    store.addTicketRelation(other.id, sub.id, 'relates-to');

    const launchable = launchableSubtickets(store, store.getSubtickets(epic.id), new Set());
    expect(launchable.map((t) => t.id)).toEqual([sub.id]);
  });

  it('does not exclude a subticket whose blocker was already DONE', () => {
    const epic = store.createEpic({ title: 'goal', description: 'goal' });
    const blocker = store.createTicket({ title: 'blocker', description: 'd' });
    store.transition({ ticketId: blocker.id, from: 'BACKLOG', to: 'DONE', role: null, verdict: 'PASS', note: null });
    const sub = store.createTicket({ title: 'sub', description: 'd', epicId: epic.id, seq: 1 });
    store.addTicketRelation(blocker.id, sub.id, 'blocks');

    const launchable = launchableSubtickets(store, store.getSubtickets(epic.id), new Set());
    expect(launchable.map((t) => t.id)).toEqual([sub.id]);
  });
});

describe('openBlockerWarning', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-schedule-'));
    store = new Store(join(dir, 'eng.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when a ticket has no open blockers', () => {
    expect(openBlockerWarning('EM-5', [])).toBeNull();
  });

  it('warns and identifies the blocking ticket by key for an explicitly run blocked ticket', () => {
    const blocker = store.createTicket({ title: 'blocker', description: 'd' });
    const target = store.createTicket({ title: 'target', description: 'd' });
    store.addTicketRelation(blocker.id, target.id, 'blocks');

    const warning = openBlockerWarning(target.key, store.openBlockersFor(target.id));
    expect(warning).toContain(target.key);
    expect(warning).toContain(blocker.key);
  });

  it('does not warn when the blocking ticket is DONE', () => {
    const blocker = store.createTicket({ title: 'blocker', description: 'd' });
    store.transition({ ticketId: blocker.id, from: 'BACKLOG', to: 'DONE', role: null, verdict: 'PASS', note: null });
    const target = store.createTicket({ title: 'target', description: 'd' });
    store.addTicketRelation(blocker.id, target.id, 'blocks');

    expect(openBlockerWarning(target.key, store.openBlockersFor(target.id))).toBeNull();
  });

  it('does not warn for a relates-to relation', () => {
    const other = store.createTicket({ title: 'other', description: 'd' });
    const target = store.createTicket({ title: 'target', description: 'd' });
    store.addTicketRelation(other.id, target.id, 'relates-to');

    expect(openBlockerWarning(target.key, store.openBlockersFor(target.id))).toBeNull();
  });
});
