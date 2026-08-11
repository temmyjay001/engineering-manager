import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/store';
import { adviceFor, leadTimeStats, percentile, type Report } from '../src/domain/report';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-report-'));
  store = new Store(join(dir, 'eng.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function doneTicket(withRework: boolean): number {
  const t = store.createTicket({ title: 't', description: 'd' });
  store.transition({ ticketId: t.id, from: 'BACKLOG', to: 'AWAIT_APPROVAL', role: 'pm', verdict: 'PASS', note: null });
  if (withRework) {
    store.transition({ ticketId: t.id, from: 'IN_REVIEW', to: 'IN_PROGRESS', role: 'reviewer', verdict: 'FAIL', note: 'defect' });
  }
  store.transition({ ticketId: t.id, from: 'UAT', to: 'DONE', role: 'uat', verdict: 'PASS', note: null });
  return t.id;
}

describe('percentile and lead time stats', () => {
  it('interpolates percentiles over sorted values', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([10], 90)).toBe(10);
    expect(percentile([10, 20], 50)).toBe(15);
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 90)).toBe(46);
  });

  it('summarizes lead times', () => {
    expect(leadTimeStats([])).toBeNull();
    expect(leadTimeStats([1000, 3000, 2000])).toEqual({ avgMs: 2000, p50Ms: 2000, p90Ms: 2800 });
  });
});

describe('buildReport', () => {
  it('reports an empty org without dividing by zero', () => {
    const report = store.buildReport(30);
    expect(report.tickets).toMatchObject({ done: 0, open: 0, blocked: 0, firstPass: 0, avgAttempts: null, leadTime: null });
    expect(report.spend.perDoneTicketUsd).toBeNull();
    expect(report.throughput).toEqual([]);
  });

  it('counts done, open, blocked, and first-pass tickets', () => {
    doneTicket(false);
    doneTicket(true);
    store.createTicket({ title: 'open', description: 'open' });
    const blocked = store.createTicket({ title: 'b', description: 'b' });
    store.transition({ ticketId: blocked.id, from: 'BACKLOG', to: 'BLOCKED', role: null, verdict: 'FAIL', note: 'abandoned' });

    const report = store.buildReport(30);
    expect(report.tickets.done).toBe(2);
    expect(report.tickets.open).toBe(1);
    expect(report.tickets.blocked).toBe(1);
    expect(report.tickets.firstPass).toBe(1);
    expect(report.tickets.leadTime).not.toBeNull();
    expect(report.throughput.reduce((sum, b) => sum + b.done, 0)).toBe(2);
  });

  it('counts gate verdicts and auto-approvals', () => {
    const t = store.createTicket({ title: 't', description: 'd' });
    store.transition({ ticketId: t.id, from: 'IN_REVIEW', to: 'IN_PROGRESS', role: 'reviewer', verdict: 'FAIL', note: 'x' });
    store.transition({ ticketId: t.id, from: 'UAT', to: 'IN_PROGRESS', role: 'uat', verdict: 'FAIL', note: 'y' });
    store.transition({ ticketId: t.id, from: 'AWAIT_APPROVAL', to: 'BACKLOG', role: null, verdict: 'FAIL', note: 'rejected' });
    store.transition({
      ticketId: t.id,
      from: 'AWAIT_APPROVAL',
      to: 'DESIGN',
      role: null,
      verdict: 'PASS',
      note: 'auto-approved (approvalMode: never)',
    });

    const report = store.buildReport(null);
    expect(report.gates).toEqual({ reviewFails: 1, uatFails: 1, humanRejections: 1, autoApprovals: 1 });
  });

  it('aggregates spend by role, runner, and model', () => {
    const t = store.createTicket({ title: 't', description: 'd' });
    store.recordAgentRun({
      ticketId: t.id, role: 'developer', runner: 'claude-sdk', model: 'claude-opus-4-8',
      status: 'OK', costUsd: 2, numTurns: 10, durationMs: 60_000, inputTokens: 1000, outputTokens: 200,
    });
    store.recordAgentRun({
      ticketId: t.id, role: 'reviewer', runner: 'codex', model: 'gpt-5.2-codex',
      status: 'ERROR', costUsd: 0.5, numTurns: 2, durationMs: 30_000, inputTokens: 500, outputTokens: 50, error: 'boom',
    });

    const report = store.buildReport(30);
    expect(report.spend.totalUsd).toBeCloseTo(2.5);
    expect(report.spend.byRole).toEqual([
      { key: 'developer', usd: 2 },
      { key: 'reviewer', usd: 0.5 },
    ]);
    expect(report.spend.byRunner.map((r) => r.key)).toEqual(['claude-sdk', 'codex']);
    expect(report.spend.byModel.map((r) => r.key)).toEqual(['claude-opus-4-8', 'gpt-5.2-codex']);
    expect(report.spend.inputTokens).toBe(1500);
    expect(report.spend.outputTokens).toBe(250);
    expect(report.runs).toMatchObject({ total: 2, errors: 1 });
    expect(report.runs.byRole.find((r) => r.role === 'developer')).toMatchObject({ runs: 1, errors: 0, avgDurationMs: 60_000 });
  });

  it('excludes activity outside the window but keeps it for all-time', () => {
    const id = doneTicket(true);
    store.recordAgentRun({ ticketId: id, role: 'developer', status: 'OK', costUsd: 1, numTurns: 1, durationMs: 1000 });

    const raw = new Database(join(dir, 'eng.db'));
    raw.exec(`
      UPDATE transitions SET created_at = '2020-01-01 00:00:00';
      UPDATE agent_runs SET created_at = '2020-01-01 00:00:00';
      UPDATE tickets SET created_at = '2019-12-31 00:00:00';
    `);
    raw.close();

    const windowed = store.buildReport(30);
    expect(windowed.tickets.done).toBe(0);
    expect(windowed.runs.total).toBe(0);
    expect(windowed.gates.reviewFails).toBe(0);
    expect(windowed.spend.totalUsd).toBe(0);
    expect(windowed.lifetime).toEqual({ totalTokens: 0, runs: 1, totalUsd: 1 });

    const allTime = store.buildReport(null);
    expect(allTime.tickets.done).toBe(1);
    expect(allTime.runs.total).toBe(1);
    expect(allTime.gates.reviewFails).toBe(1);
    expect(allTime.tickets.leadTime?.avgMs).toBe(24 * 3600 * 1000);
    expect(allTime.lifetime).toEqual(windowed.lifetime);
  });

  it('sums lifetime tokens, runs, and usd across every run regardless of window', () => {
    const t = store.createTicket({ title: 't', description: 'd' });
    store.recordAgentRun({
      ticketId: t.id, role: 'developer', status: 'OK', costUsd: 2, numTurns: 1, durationMs: 1000,
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 25,
    });
    store.recordAgentRun({
      ticketId: t.id, role: 'reviewer', status: 'ERROR', costUsd: 0.5, numTurns: 1, durationMs: 500,
      inputTokens: 300, outputTokens: 25, error: 'boom',
    });

    const report = store.buildReport(30);
    expect(report.lifetime).toEqual({ totalTokens: 1600, runs: 2, totalUsd: 2.5 });

    const allTime = store.buildReport(null);
    expect(allTime.lifetime).toEqual(report.lifetime);
  });
});

function reportWith(overrides: {
  byRole?: Array<{ key: string; usd: number }>;
  totalUsd?: number;
  runs?: { total: number; errors: number };
  month?: { spentUsd: number; budgetUsd: number | null };
}): Report {
  return {
    windowDays: 30,
    lifetime: { totalTokens: 0, runs: overrides.runs?.total ?? 5, totalUsd: overrides.totalUsd ?? 10 },
    tickets: { done: 5, open: 0, blocked: 0, firstPass: 5, avgAttempts: 0, leadTime: null, agentTimeMs: 0 },
    throughput: [],
    gates: { reviewFails: 0, uatFails: 0, humanRejections: 0, autoApprovals: 0 },
    spend: {
      totalUsd: overrides.totalUsd ?? 10,
      perDoneTicketUsd: 2,
      byRole: overrides.byRole ?? [],
      byRunner: [],
      byModel: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokensByRole: [],
    },
    runs: { total: overrides.runs?.total ?? 5, errors: overrides.runs?.errors ?? 0, byRole: [] },
    month: overrides.month ?? { spentUsd: 0, budgetUsd: null },
  };
}

describe('adviceFor', () => {
  it('suggests a mid-tier model when one role dominates spend on a premium model', () => {
    const report = reportWith({ byRole: [{ key: 'uat', usd: 6 }, { key: 'pm', usd: 4 }], totalUsd: 10 });
    const advice = adviceFor(report, {}, 'claude-opus-4-8');
    expect(advice.some((a) => a.includes('uat is 60% of spend on claude-opus-4-8'))).toBe(true);
  });

  it('stays quiet when the dominant role already runs a cheap model', () => {
    const report = reportWith({ byRole: [{ key: 'uat', usd: 6 }], totalUsd: 10 });
    expect(adviceFor(report, { uat: 'claude-sonnet-5' }, 'claude-opus-4-8')).toEqual([]);
  });

  it('flags high error rates and budget burn', () => {
    const report = reportWith({
      runs: { total: 10, errors: 3 },
      month: { spentUsd: 45, budgetUsd: 50 },
    });
    const advice = adviceFor(report, {}, 'claude-opus-4-8');
    expect(advice.some((a) => a.includes('30% of agent runs errored'))).toBe(true);
    expect(advice.some((a) => a.includes('$45.00 of the $50.00 budget (90%)'))).toBe(true);
  });
});
