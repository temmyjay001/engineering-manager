import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  architectContract,
  developerContract,
  pmContract,
  plannerContract,
  reviewerContract,
  uatContract,
} from '../src/agents/contracts';
import { AgentIdleTimeoutError, ClaudeSdkRunner, startIdleWatchdog, toApiSchema } from '../src/agents/runner';

let fakeQueryImpl: (args: { prompt: string; options: { abortController: AbortController } }) => AsyncGenerator<unknown>;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: { abortController: AbortController } }) => fakeQueryImpl(args),
}));

const UNSUPPORTED = ['$schema', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'default', 'pattern', 'format'];

function collectSchemaKeys(node: unknown, keys: Set<string>, isNameMap = false): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaKeys(item, keys);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (!isNameMap) keys.add(key);
      collectSchemaKeys(value, keys, !isNameMap && key === 'properties');
    }
  }
}

describe('toApiSchema', () => {
  it('strips keywords the SDK json_schema path rejects, for every contract', () => {
    for (const contract of [plannerContract, pmContract, architectContract, developerContract, reviewerContract, uatContract]) {
      const keys = new Set<string>();
      collectSchemaKeys(toApiSchema(contract), keys);
      for (const bad of UNSUPPORTED) expect(keys.has(bad), `${bad} should be stripped`).toBe(false);
    }
  });

  it('keeps the structural keywords the harness needs', () => {
    const schema = toApiSchema(pmContract) as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toContain('acceptanceCriteria');
    expect(schema.required).toContain('title');
  });

  it('does not strip properties whose names collide with schema keywords', () => {
    const tricky = z.object({
      format: z.string(),
      pattern: z.string(),
      default: z.boolean(),
      minimum: z.number(),
    });
    const schema = toApiSchema(tricky) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(['default', 'format', 'minimum', 'pattern']);
    expect(schema.required.sort()).toEqual(['default', 'format', 'minimum', 'pattern']);
  });

  it('still strips keyword keys from the schemas of tricky-named properties', () => {
    const tricky = z.object({ format: z.string().max(10) });
    const schema = toApiSchema(tricky) as { properties: { format: Record<string, unknown> } };
    expect(schema.properties.format.type).toBe('string');
    expect(schema.properties.format).not.toHaveProperty('maxLength');
  });
});

describe('startIdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onIdle once the window elapses with no touch()', () => {
    const onIdle = vi.fn();
    startIdleWatchdog(5, onIdle);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('resets the window on touch(), delaying onIdle', () => {
    const onIdle = vi.fn();
    const watchdog = startIdleWatchdog(5, onIdle);
    vi.advanceTimersByTime(4 * 60_000);
    watchdog.touch();
    vi.advanceTimersByTime(4 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('stop() prevents onIdle from firing', () => {
    const onIdle = vi.fn();
    const watchdog = startIdleWatchdog(5, onIdle);
    watchdog.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe('AgentIdleTimeoutError', () => {
  it('carries the idle window in its message and pluralizes minutes', () => {
    expect(new AgentIdleTimeoutError(15).message).toBe('idle timeout: no activity for 15 minutes');
    expect(new AgentIdleTimeoutError(1).message).toBe('idle timeout: no activity for 1 minute');
  });

  it('carries partial tokens, cost, and serving model', () => {
    const tokens = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 };
    const err = new AgentIdleTimeoutError(15, tokens, 0.5, 'claude-x');
    expect(err.tokens).toEqual(tokens);
    expect(err.costUsd).toBe(0.5);
    expect(err.servingModel).toBe('claude-x');
    expect(err.idleMinutes).toBe(15);
  });
});

describe('ClaudeSdkRunner against a fake query() stream', () => {
  const contract = z.object({ verdict: z.enum(['PASS', 'FAIL']) });

  function jobFor(idleTimeoutMinutes: number) {
    return {
      role: 'reviewer' as const,
      prompt: 'Judge the change.',
      systemPrompt: 'You are the reviewer.',
      cwd: process.cwd(),
      contract,
      model: 'fake-model',
      maxTurns: 10,
      idleTimeoutMinutes,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts, kills the stream, and records partial usage on prolonged silence', async () => {
    let abortedCount = 0;
    fakeQueryImpl = async function* (args) {
      yield {
        type: 'assistant',
        message: { usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } },
      };
      await new Promise((_resolve, reject) => {
        args.options.abortController.signal.addEventListener('abort', () => {
          abortedCount += 1;
          reject(new Error('aborted'));
        });
      });
    };

    const runner = new ClaudeSdkRunner();
    const outcome = runner.run(jobFor(0.01)).catch((e) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const err: AgentIdleTimeoutError = await outcome;

    expect(err).toBeInstanceOf(AgentIdleTimeoutError);
    expect(err.message).toMatch(/idle timeout/);
    expect(err.tokens).toEqual({ input: 7, output: 3, cacheRead: 1, cacheWrite: 0 });
    expect(abortedCount).toBe(1);
  });

  it('does not retry an idle timeout through the internal 2-attempt loop', async () => {
    let calls = 0;
    fakeQueryImpl = async function* (args) {
      calls += 1;
      await new Promise((_resolve, reject) => {
        args.options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };

    const runner = new ClaudeSdkRunner();
    const outcome = runner.run(jobFor(0.01)).catch((e) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const err: AgentIdleTimeoutError = await outcome;

    expect(err).toBeInstanceOf(AgentIdleTimeoutError);
    expect(calls).toBe(1);
  });
});
