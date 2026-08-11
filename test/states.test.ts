import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PIPELINE,
  roleForState,
  unblockTarget,
  failTarget,
  firstBuildState,
  isRework,
  isTerminal,
  pipelineGates,
  resolveStage,
  validatePipeline,
} from '../src/domain/states';
import type { TicketState } from '../src/domain/types';

function at(status: TicketState, gate: string | null = null) {
  return { status, gate };
}

function agent(pipeline: string[], status: TicketState, gate: string | null = null) {
  const stage = resolveStage(pipeline, at(status, gate));
  if (!stage || stage.kind !== 'agent') throw new Error(`expected agent stage at ${status}, got ${JSON.stringify(stage)}`);
  return stage;
}

describe('validatePipeline', () => {
  it('accepts the default pipeline', () => {
    expect(validatePipeline(DEFAULT_PIPELINE)).toBeNull();
  });

  it('accepts skips and custom gates after developer', () => {
    expect(validatePipeline(['pm', 'developer'])).toBeNull();
    expect(validatePipeline(['pm', 'developer', 'security', 'uat'])).toBeNull();
  });

  it('rejects structural violations', () => {
    expect(validatePipeline(['developer', 'pm'])).toMatch(/start with pm/);
    expect(validatePipeline(['pm', 'reviewer'])).toMatch(/include developer/);
    expect(validatePipeline(['pm', 'developer', 'architect'])).toMatch(/architect must come before developer/);
    expect(validatePipeline(['pm', 'security', 'developer'])).toMatch(/custom gate "security" must come after developer/);
    expect(validatePipeline(['pm', 'developer', 'uat', 'uat'])).toMatch(/unique/);
    expect(validatePipeline(['pm', 'developer', 'approval'])).toMatch(/reserved/);
  });
});

describe('resolveStage on the default pipeline', () => {
  it('routes the happy path end to end', () => {
    expect(agent(DEFAULT_PIPELINE, 'BACKLOG')).toMatchObject({ role: 'pm', onPass: 'AWAIT_APPROVAL' });
    expect(resolveStage(DEFAULT_PIPELINE, at('AWAIT_APPROVAL'))).toMatchObject({ kind: 'human', onApprove: 'DESIGN' });
    expect(agent(DEFAULT_PIPELINE, 'DESIGN')).toMatchObject({ role: 'architect', onPass: 'READY' });
    expect(agent(DEFAULT_PIPELINE, 'READY')).toMatchObject({ role: 'developer', onPass: 'IN_REVIEW', onPassGate: 'reviewer' });
    expect(agent(DEFAULT_PIPELINE, 'IN_REVIEW')).toMatchObject({ role: 'reviewer', onPass: 'UAT', onPassGate: 'uat' });
    expect(agent(DEFAULT_PIPELINE, 'UAT')).toMatchObject({ role: 'uat', onPass: 'READY_TO_LAND', onPassGate: null });
  });

  it('loops review and UAT failures back to the developer', () => {
    expect(agent(DEFAULT_PIPELINE, 'IN_REVIEW').onFail).toBe('IN_PROGRESS');
    expect(agent(DEFAULT_PIPELINE, 'UAT').onFail).toBe('IN_PROGRESS');
  });

  it('returns null on terminal states', () => {
    expect(resolveStage(DEFAULT_PIPELINE, at('DONE'))).toBeNull();
    expect(resolveStage(DEFAULT_PIPELINE, at('BLOCKED'))).toBeNull();
  });
});

describe('resolveStage on customized pipelines', () => {
  it('skips straight to READY when architect is absent', () => {
    const pipeline = ['pm', 'developer', 'reviewer'];
    expect(firstBuildState(pipeline)).toBe('READY');
    expect(resolveStage(pipeline, at('AWAIT_APPROVAL'))).toMatchObject({ kind: 'human', onApprove: 'READY' });
    expect(resolveStage(pipeline, at('DESIGN'))).toMatchObject({ kind: 'skip', to: 'READY' });
  });

  it('goes developer -> DONE with no gates at all', () => {
    expect(agent(['pm', 'developer'], 'READY')).toMatchObject({ onPass: 'READY_TO_LAND', onPassGate: null });
  });

  it('threads custom gates in order through IN_REVIEW', () => {
    const pipeline = ['pm', 'developer', 'reviewer', 'security', 'uat'];
    expect(pipelineGates(pipeline)).toEqual(['reviewer', 'security', 'uat']);
    expect(agent(pipeline, 'READY')).toMatchObject({ onPass: 'IN_REVIEW', onPassGate: 'reviewer' });
    expect(agent(pipeline, 'IN_REVIEW', 'reviewer')).toMatchObject({
      role: 'reviewer',
      onPass: 'IN_REVIEW',
      onPassGate: 'security',
    });
    expect(agent(pipeline, 'IN_REVIEW', 'security')).toMatchObject({ role: 'security', onPass: 'UAT', onPassGate: 'uat' });
    expect(agent(pipeline, 'UAT')).toMatchObject({ role: 'uat', onPass: 'READY_TO_LAND' });
    expect(agent(pipeline, 'IN_REVIEW', 'security').onFail).toBe('IN_PROGRESS');
  });

  it('falls back to the first matching gate when the gate marker is stale', () => {
    const pipeline = ['pm', 'developer', 'reviewer', 'uat'];
    expect(agent(pipeline, 'IN_REVIEW', 'ghost')).toMatchObject({ role: 'reviewer' });
    expect(agent(pipeline, 'IN_REVIEW')).toMatchObject({ role: 'reviewer' });
  });

  it('skips orphaned gate states after a config change', () => {
    expect(resolveStage(['pm', 'developer'], at('IN_REVIEW'))).toMatchObject({ kind: 'skip', to: 'READY_TO_LAND' });
    expect(resolveStage(['pm', 'developer', 'uat'], at('IN_REVIEW'))).toMatchObject({
      kind: 'skip',
      to: 'UAT',
      gate: 'uat',
    });
    expect(resolveStage(['pm', 'developer', 'reviewer'], at('UAT'))).toMatchObject({
      kind: 'skip',
      to: 'IN_REVIEW',
      gate: 'reviewer',
    });
  });
});

describe('terminality and rework', () => {
  it('marks DONE and BLOCKED terminal', () => {
    expect(isTerminal('DONE')).toBe(true);
    expect(isTerminal('BLOCKED')).toBe(true);
    expect(isTerminal('BACKLOG')).toBe(false);
  });

  it('identifies rework transitions', () => {
    expect(isRework('IN_PROGRESS')).toBe(true);
    expect(isRework('IN_REVIEW')).toBe(false);
  });

  it('escalates rework failures to BLOCKED at maxAttempts', () => {
    const review = agent(DEFAULT_PIPELINE, 'IN_REVIEW');
    expect(failTarget(review, 2, 3)).toBe('IN_PROGRESS');
    expect(failTarget(review, 3, 3)).toBe('BLOCKED');
    expect(failTarget(agent(DEFAULT_PIPELINE, 'DESIGN'), 0, 3)).toBe('BLOCKED');
  });
});

describe('unblockTarget', () => {
  const withCustom = ['pm', 'architect', 'developer', 'reviewer', 'security', 'uat'];

  it('returns the ticket to the stage it blocked from', () => {
    expect(unblockTarget(DEFAULT_PIPELINE, { from: 'BACKLOG', role: 'pm' }, false)).toBe('BACKLOG');
    expect(unblockTarget(DEFAULT_PIPELINE, { from: 'DESIGN', role: 'architect' }, true)).toBe('DESIGN');
    expect(unblockTarget(DEFAULT_PIPELINE, { from: 'READY', role: null }, true)).toBe('READY');
    expect(unblockTarget(DEFAULT_PIPELINE, { from: 'AWAIT_APPROVAL', role: null }, false)).toBe('AWAIT_APPROVAL');
  });

  it('routes gate failures back to the developer', () => {
    expect(unblockTarget(DEFAULT_PIPELINE, { from: 'IN_REVIEW', role: 'reviewer' }, true)).toBe('IN_PROGRESS');
    expect(unblockTarget(DEFAULT_PIPELINE, { from: 'UAT', role: 'uat' }, true)).toBe('IN_PROGRESS');
    expect(unblockTarget(withCustom, { from: 'IN_REVIEW', role: 'security' }, true)).toBe('IN_PROGRESS');
  });

  it('budget blocks mid-gate return to the gate itself', () => {
    expect(unblockTarget(DEFAULT_PIPELINE, { from: 'UAT', role: null }, true)).toBe('UAT');
    expect(unblockTarget(DEFAULT_PIPELINE, { from: 'IN_REVIEW', role: null }, true)).toBe('IN_REVIEW');
  });

  it('falls back sensibly without history', () => {
    expect(unblockTarget(DEFAULT_PIPELINE, null, true)).toBe('IN_PROGRESS');
    expect(unblockTarget(DEFAULT_PIPELINE, null, false)).toBe('BACKLOG');
  });

  it('names the receiving role for the UI', () => {
    expect(roleForState(DEFAULT_PIPELINE, 'DESIGN')).toBe('architect');
    expect(roleForState(DEFAULT_PIPELINE, 'IN_PROGRESS')).toBe('developer');
    expect(roleForState(DEFAULT_PIPELINE, 'AWAIT_APPROVAL')).toBe('your decision');
  });
});
