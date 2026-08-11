import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  architectContract,
  developerContract,
  pmContract,
  pmDraftContract,
  plannerContract,
  reviewerContract,
  uatContract,
} from '../src/agents/contracts';

describe('contracts', () => {
  it('accepts a complete PM payload', () => {
    const out = pmContract.parse({
      title: 'Add toggle',
      hasUi: true,
      runCommand: 'npm run dev',
      appUrl: 'http://localhost:3000',
      acceptanceCriteria: [{ text: 'A toggle is visible', isUi: true }],
      summary: 'Adds a toggle',
    });
    expect(out.acceptanceCriteria).toHaveLength(1);
  });

  it('rejects a PM payload without criteria', () => {
    expect(() =>
      pmContract.parse({
        title: 't',
        hasUi: false,
        runCommand: null,
        appUrl: null,
        acceptanceCriteria: [],
        summary: 's',
      }),
    ).toThrow();
  });

  it('accepts a complete PM draft payload', () => {
    const out = pmDraftContract.parse({
      title: 'Add toggle',
      acceptanceCriteria: ['A toggle is visible'],
      priority: 'medium',
      labels: ['ui'],
      reply: '',
    });
    expect(out.title).toBe('Add toggle');
    expect(out.acceptanceCriteria).toEqual(['A toggle is visible']);
    expect(out.priority).toBe('medium');
    expect(out.labels).toEqual(['ui']);
    expect(out.reply).toBe('');
  });

  it('accepts a PM draft payload with clarifying questions and no labels', () => {
    const out = pmDraftContract.parse({
      title: 'Add toggle',
      acceptanceCriteria: ['A toggle is visible'],
      priority: 'high',
      labels: [],
      reply: 'Should this apply to all users or only admins?',
    });
    expect(out.labels).toEqual([]);
    expect(out.reply).toBe('Should this apply to all users or only admins?');
  });

  it('rejects a PM draft payload missing acceptance criteria', () => {
    expect(() =>
      pmDraftContract.parse({
        title: 't',
        acceptanceCriteria: [],
        priority: 'low',
        labels: [],
        reply: '',
      }),
    ).toThrow();
  });

  it.each(['title', 'acceptanceCriteria', 'priority', 'labels', 'reply'])(
    'rejects a PM draft payload missing %s',
    (field) => {
      const payload: Record<string, unknown> = {
        title: 't',
        acceptanceCriteria: ['A precise statement'],
        priority: 'low',
        labels: [],
        reply: '',
      };
      delete payload[field];
      expect(() => pmDraftContract.parse(payload)).toThrow();
    },
  );

  it('fills reviewer and uat defaults', () => {
    const review = reviewerContract.parse({ verdict: 'PASS', summary: 'ok' });
    expect(review.findings).toEqual([]);
    const uat = uatContract.parse({ verdict: 'FAIL', summary: 'nope', results: [{ idx: 1, met: false }] });
    expect(uat.results[0]?.evidence).toBe('');
  });

  it('fills architect and developer defaults', () => {
    expect(architectContract.parse({ verdict: 'PASS', summary: 's' }).blockers).toEqual([]);
    expect(developerContract.parse({ verdict: 'PASS', summary: 's' }).notes).toBe('');
  });

  it('requires at least one planned subticket', () => {
    expect(() => plannerContract.parse({ summary: 's', subtickets: [] })).toThrow();
  });

  it('converts to JSON schema for the structured output harness', () => {
    for (const contract of [
      plannerContract,
      pmContract,
      pmDraftContract,
      architectContract,
      developerContract,
      reviewerContract,
      uatContract,
    ]) {
      const schema = z.toJSONSchema(contract);
      expect(schema).toMatchObject({ type: 'object' });
    }
  });
});
