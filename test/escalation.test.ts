import { describe, expect, it } from 'vitest';
import { modelForAttempt } from '../src/agents/invoke';

describe('modelForAttempt', () => {
  const ladder = { escalation: ['claude-sonnet-5', 'claude-opus-4-8'] };

  it('climbs the ladder by attempt and clamps at the top', () => {
    expect(modelForAttempt(ladder, 'developer', 0)).toBe('claude-sonnet-5');
    expect(modelForAttempt(ladder, 'developer', 1)).toBe('claude-opus-4-8');
    expect(modelForAttempt(ladder, 'developer', 5)).toBe('claude-opus-4-8');
  });

  it('prefers the ladder over a plain model override', () => {
    expect(modelForAttempt({ ...ladder, model: 'claude-haiku-4-5' }, 'developer', 0)).toBe('claude-sonnet-5');
  });

  it('falls back to model override, role default, then global default', () => {
    expect(modelForAttempt({ model: 'claude-haiku-4-5' }, 'developer', 3)).toBe('claude-haiku-4-5');
    expect(modelForAttempt({}, 'developer', 0)).toBe('claude-opus-4-8');
    expect(modelForAttempt({}, 'security', 0)).toBe('claude-opus-4-8');
  });

  it('lets an explicit model (meetings) beat everything', () => {
    expect(modelForAttempt(ladder, 'pm', 2, 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });
});
