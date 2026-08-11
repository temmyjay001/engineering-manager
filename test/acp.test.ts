import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AcpRunner,
  applyUpdate,
  pickPermissionOption,
  toAcpMcpServers,
  type AcpTurn,
} from '../src/agents/acp';
import { parseCliRunnerSpec } from '../src/project';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, 'fixtures', 'fake-acp-agent.mjs');

const contract = z.object({ verdict: z.enum(['PASS', 'FAIL']) });

function runnerWith(mode: string): AcpRunner {
  return new AcpRunner(
    'fake-acp',
    parseCliRunnerSpec({
      kind: 'acp',
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { FAKE_ACP_MODE: mode },
      timeoutMinutes: 1,
    }),
  );
}

function jobFor(mode: string, onActivity?: (line: string) => void) {
  return {
    role: 'reviewer' as const,
    prompt: 'Judge the change.',
    systemPrompt: 'You are the reviewer.',
    cwd: here,
    contract,
    model: 'fake-model',
    maxTurns: 10,
    onActivity,
  };
}

describe('acp helpers', () => {
  it('prefers allow_once, then allow_always, then null', () => {
    expect(
      pickPermissionOption([
        { optionId: 'r', kind: 'reject_once' },
        { optionId: 'aa', kind: 'allow_always' },
        { optionId: 'ao', kind: 'allow_once' },
      ]),
    ).toBe('ao');
    expect(pickPermissionOption([{ optionId: 'aa', kind: 'allow_always' }])).toBe('aa');
    expect(pickPermissionOption([{ optionId: 'r', kind: 'reject_once' }])).toBeNull();
  });

  it('converts stdio MCP specs to ACP shape and rejects remote ones', () => {
    expect(
      toAcpMcpServers({ docs: { command: 'docs-mcp', args: ['--stdio'], env: { TOKEN: 'x' } } }),
    ).toEqual([{ name: 'docs', command: 'docs-mcp', args: ['--stdio'], env: [{ name: 'TOKEN', value: 'x' }] }]);
    expect(() =>
      toAcpMcpServers({ remote: { type: 'http', url: 'https://x', headers: {} } }),
    ).toThrow(/stdio MCP servers only/);
    expect(toAcpMcpServers(undefined)).toEqual([]);
  });

  it('accumulates message text and counts tool calls', () => {
    const turn: AcpTurn = { text: '', toolCalls: 0 };
    expect(applyUpdate(turn, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } })).toBeUndefined();
    expect(applyUpdate(turn, { sessionUpdate: 'tool_call', title: 'grep', kind: 'search' })).toBe('search: grep');
    expect(applyUpdate(turn, { sessionUpdate: 'tool_call_update', status: 'failed', title: 'grep' })).toContain('failed');
    expect(turn).toEqual({ text: 'a', toolCalls: 1 });
  });
});

describe('AcpRunner against a fake agent', () => {
  it('completes a turn: permissions auto-allowed, activity emitted, contract parsed', async () => {
    const activity: string[] = [];
    const outcome = await runnerWith('happy').run(jobFor('happy', (line) => activity.push(line)));
    expect(outcome.output).toEqual({ verdict: 'PASS' });
    expect(outcome.numTurns).toBe(1);
    expect(outcome.text).toContain('Done.');
    expect(activity.some((l) => l.includes('read: read the readme'))).toBe(true);
    expect(activity.some((l) => l.includes('permission auto-approved'))).toBe(true);
  });

  it('surfaces refusals with the stop reason', async () => {
    await expect(runnerWith('refuse').run(jobFor('refuse'))).rejects.toThrow(/refusal/);
  });

  it('maps the auth error to actionable guidance', async () => {
    await expect(runnerWith('authgate').run(jobFor('authgate'))).rejects.toThrow(/requires authentication/);
  });

  it('fails cleanly when the agent dies mid-turn', async () => {
    await expect(runnerWith('silent').run(jobFor('silent'))).rejects.toThrow(/exited before the turn finished/);
  });

  it('aborts and kills the process on prolonged silence', async () => {
    const runner = runnerWith('stall');
    const err: any = await runner
      .run({ ...jobFor('stall'), idleTimeoutMinutes: 0.02 })
      .catch((e) => e);
    expect(err.message).toMatch(/idle timeout/);
  }, 15000);

  it('captures token usage and the actual serving model from _meta.quota on success', async () => {
    const outcome = await runnerWith('quota').run(jobFor('quota'));
    expect(outcome.output).toEqual({ verdict: 'PASS' });
    expect(outcome.tokens).toEqual({ input: 500, output: 120, cacheRead: 0, cacheWrite: 0 });
    expect(outcome.servingModel).toBe('gemini-3.5-flash');
  });

  it('carries partial token usage and serving model through a cancelled turn', async () => {
    const err: any = await runnerWith('cancelled')
      .run(jobFor('cancelled'))
      .catch((e) => e);
    expect(err.message).toMatch(/cancelled/);
    expect(err.tokens).toEqual({ input: 80, output: 12, cacheRead: 0, cacheWrite: 0 });
    expect(err.servingModel).toBe('gemini-3.5-flash');
  });

  it('merges token usage from a failed first attempt into a successful retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'em-acp-retry-'));
    const stateFile = join(dir, 'attempt-state');
    const runner = new AcpRunner(
      'fake-acp',
      parseCliRunnerSpec({
        kind: 'acp',
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { FAKE_ACP_MODE: 'retry-quota', FAKE_ACP_STATE_FILE: stateFile },
        timeoutMinutes: 1,
      }),
    );
    try {
      const outcome = await runner.run(jobFor('retry-quota'));
      expect(outcome.output).toEqual({ verdict: 'PASS' });
      expect(outcome.tokens).toEqual({ input: 580, output: 132, cacheRead: 0, cacheWrite: 0 });
      expect(outcome.servingModel).toBe('gemini-3.5-flash');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
