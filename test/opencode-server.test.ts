import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyEvent, newTurnState, OpencodeServerRunner, parseModelRef, type SessionEvent } from '../src/agents/opencode-server';

function stepEnded(finish: string, extra: Record<string, unknown> = {}): SessionEvent {
  return {
    type: 'session.next.step.ended',
    properties: {
      finish,
      cost: 0.01,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 0 } },
      ...extra,
    },
  };
}

describe('parseModelRef', () => {
  it('splits provider and model on the first slash', () => {
    expect(parseModelRef('openai/gpt-4.1-mini')).toEqual({ providerID: 'openai', id: 'gpt-4.1-mini' });
    expect(parseModelRef('openrouter/deepseek/deepseek-chat')).toEqual({
      providerID: 'openrouter',
      id: 'deepseek/deepseek-chat',
    });
  });

  it('rejects bare model ids', () => {
    expect(() => parseModelRef('gpt-4.1-mini')).toThrow(/provider\/model/);
    expect(() => parseModelRef('openai/')).toThrow(/provider\/model/);
    expect(() => parseModelRef('/gpt')).toThrow(/provider\/model/);
  });
});

describe('applyEvent', () => {
  it('accumulates usage across steps and completes on a terminal finish', () => {
    const state = newTurnState();
    expect(applyEvent(state, stepEnded('tool-calls')).done).toBe(false);
    const final = applyEvent(state, stepEnded('stop'));
    expect(final.done).toBe(true);
    expect(final.activity).toContain('stop');
    expect(state.steps).toBe(2);
    expect(state.finish).toBe('stop');
    expect(state.tokens).toEqual({ input: 200, output: 50, cacheRead: 60, cacheWrite: 0 });
    expect(state.costUsd).toBeCloseTo(0.02);
  });

  it('collects assistant text from text.ended events', () => {
    const state = newTurnState();
    applyEvent(state, { type: 'session.next.text.ended', properties: { text: 'part one' } });
    applyEvent(state, { type: 'session.next.text.ended', properties: { text: '  ' } });
    applyEvent(state, { type: 'session.next.text.ended', data: { text: 'part two' } });
    expect(state.texts).toEqual(['part one', 'part two']);
  });

  it('surfaces tool calls as activity lines', () => {
    const state = newTurnState();
    const update = applyEvent(state, {
      type: 'session.next.tool.called',
      properties: { tool: 'bash', input: { command: 'ls' } },
    });
    expect(update.activity).toBe('bash {"command":"ls"}');
    expect(update.done).toBe(false);
  });

  it('fails the turn on step.failed and session.error', () => {
    const failed = newTurnState();
    expect(applyEvent(failed, { type: 'session.next.step.failed', properties: { error: 'boom' } }).done).toBe(true);
    expect(failed.failure).toBe('boom');

    const errored = newTurnState();
    expect(applyEvent(errored, { type: 'session.error', data: { message: 'dead' } }).done).toBe(true);
    expect(errored.failure).toBe('dead');
  });

  it('extracts permission request ids for auto-reply', () => {
    const state = newTurnState();
    const update = applyEvent(state, {
      type: 'permission.v2.asked',
      properties: { id: 'per_123', sessionID: 'ses_1', action: 'bash', resources: [] },
    });
    expect(update.permissionId).toBe('per_123');
    expect(update.done).toBe(false);
  });

  it('ignores unrelated events', () => {
    const state = newTurnState();
    for (const type of ['session.created', 'session.next.prompted', 'session.next.text.started', 'storage.write']) {
      expect(applyEvent(state, { type }).done).toBe(false);
    }
    expect(state.steps).toBe(0);
  });
});

describe('OpencodeServerRunner against a fake server', () => {
  let server: Server;
  let baseUrl: string;

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200).end();
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { id: 'ses_1' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/session/ses_1/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session.next.step.started' })}\n\n`);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_1/prompt') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({}));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_1/interrupt') {
      res.writeHead(200).end();
      return;
    }
    res.writeHead(404).end();
  }

  beforeEach(async () => {
    server = createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('aborts and records the idle timeout once the event stream goes silent', async () => {
    const runner = new OpencodeServerRunner(baseUrl);
    const err: any = await runner
      .run({
        role: 'reviewer',
        prompt: 'Judge the change.',
        systemPrompt: 'You are the reviewer.',
        cwd: process.cwd(),
        contract: z.object({ verdict: z.enum(['PASS', 'FAIL']) }),
        model: 'openai/gpt-4.1-mini',
        maxTurns: 5,
        idleTimeoutMinutes: 0.02,
      })
      .catch((e) => e);
    expect(err.message).toMatch(/idle timeout/);
  }, 15000);
});
