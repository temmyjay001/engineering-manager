import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CliRunner, parseClaudeResult } from '../src/agents/cli';
import { parseCliRunnerSpec } from '../src/project';

const echoContract = z.object({ ok: z.boolean(), sawPrompt: z.boolean() });

const baseJob = {
  role: 'reviewer' as const,
  prompt: 'the task prompt',
  systemPrompt: 'system rules',
  cwd: process.cwd(),
  model: 'test-model',
  maxTurns: 5,
};

function fakeCli(script: string, extra: Record<string, unknown> = {}) {
  return parseCliRunnerSpec({ command: process.execPath, args: ['-e', script], ...extra });
}

describe('CliRunner generic kind', () => {
  it('delivers the prompt on stdin and parses the fenced result', async () => {
    const script = `
      const input = require('fs').readFileSync(0, 'utf8');
      const sawPrompt = input.includes('the task prompt') && input.includes('system rules');
      console.log('report body');
      console.log('\\u0060\\u0060\\u0060json');
      console.log(JSON.stringify({ ok: true, sawPrompt }));
      console.log('\\u0060\\u0060\\u0060');
    `;
    const runner = new CliRunner('fake', fakeCli(script));
    const outcome = await runner.run({ ...baseJob, contract: echoContract });
    expect(outcome.output).toEqual({ ok: true, sawPrompt: true });
    expect(outcome.text).toContain('report body');
    expect(outcome.costUsd).toBe(0);
  });

  it('substitutes placeholders in args', async () => {
    const script = `
      console.log('\\u0060\\u0060\\u0060json');
      console.log(JSON.stringify({ model: process.argv[1], turns: process.argv[2] }));
      console.log('\\u0060\\u0060\\u0060');
    `;
    const spec = parseCliRunnerSpec({
      command: process.execPath,
      args: ['-e', script, '{model}', '{maxTurns}'],
    });
    const runner = new CliRunner('fake', spec);
    const contract = z.object({ model: z.string(), turns: z.string() });
    const outcome = await runner.run({ ...baseJob, contract });
    expect(outcome.output).toEqual({ model: 'test-model', turns: '5' });
  });

  it('rejects unknown placeholders', async () => {
    const spec = fakeCli('', { args: ['-e', 'console.log(1)', '{nope}'] });
    const runner = new CliRunner('fake', spec);
    await expect(runner.run({ ...baseJob, contract: echoContract })).rejects.toThrow(/Unknown placeholder/);
  });

  it('fails after two attempts when output has no JSON', async () => {
    const runner = new CliRunner('fake', fakeCli(`console.log('just prose')`));
    await expect(runner.run({ ...baseJob, contract: echoContract })).rejects.toThrow(/after 2 attempts/);
  });

  it('surfaces stderr on non-zero exit', async () => {
    const runner = new CliRunner('fake', fakeCli(`console.error('boom'); process.exit(3)`));
    await expect(runner.run({ ...baseJob, contract: echoContract })).rejects.toThrow(/code 3.*boom/s);
  });

  it('times out runaway commands', async () => {
    const spec = fakeCli(`setTimeout(() => {}, 60000)`, { timeoutMinutes: 0.02 });
    const runner = new CliRunner('fake', spec);
    await expect(runner.run({ ...baseJob, contract: echoContract })).rejects.toThrow(/timed out/);
  }, 15000);

  it('aborts on prolonged silence, killing the process, even under the wall-clock cap', async () => {
    const spec = fakeCli(`setTimeout(() => {}, 60000)`);
    const runner = new CliRunner('fake', spec);
    await expect(
      runner.run({ ...baseJob, contract: echoContract, idleTimeoutMinutes: 0.02 }),
    ).rejects.toThrow(/idle timeout/);
  }, 15000);

  it('refuses browser jobs without browser support', async () => {
    const runner = new CliRunner('fake', fakeCli('console.log(1)'));
    await expect(runner.run({ ...baseJob, contract: echoContract, browser: true })).rejects.toThrow(
      /no browser support/,
    );
  });

  it('claude kind reports read-only enforcement, generic defaults off', () => {
    expect(new CliRunner('a', parseCliRunnerSpec({ kind: 'claude', command: 'claude' })).enforcesReadOnly).toBe(true);
    expect(new CliRunner('b', fakeCli('')).enforcesReadOnly).toBe(false);
    expect(new CliRunner('c', fakeCli('', { enforcesReadOnly: true })).enforcesReadOnly).toBe(true);
  });
});

describe('provider output parsers', () => {
  it('parses codex JSONL events into text and tokens', async () => {
    const { parseCodexOutput } = await import('../src/agents/cli');
    const stdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"metadata warning"}}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"report\\n\\u0060\\u0060\\u0060json\\n{\\"ok\\":true}\\n\\u0060\\u0060\\u0060"}}',
      '{"type":"turn.completed","usage":{"input_tokens":13411,"cached_input_tokens":11136,"output_tokens":22,"reasoning_output_tokens":8}}',
    ].join('\n');
    const parsed = parseCodexOutput(stdout);
    expect(parsed.text).toContain('report');
    expect(parsed.tokens).toEqual({ input: 13411, output: 30, cacheRead: 11136, cacheWrite: 0 });
  });

  it('parses gemini JSON output into text and tokens', async () => {
    const { parseGeminiOutput } = await import('../src/agents/cli');
    const stdout = JSON.stringify({
      response: 'OK',
      stats: {
        models: {
          'gemini-3.5-flash': { tokens: { prompt: 9209, candidates: 1, thoughts: 199, total: 9409 } },
          'gemini-3.1-flash-lite': { tokens: { prompt: 100, candidates: 5, thoughts: 0 } },
        },
      },
    });
    const parsed = parseGeminiOutput(stdout);
    expect(parsed.text).toBe('OK');
    expect(parsed.tokens).toEqual({ input: 9309, output: 205, cacheRead: 0, cacheWrite: 0 });
  });

  it('parses opencode JSON events into text, tokens, and native cost', async () => {
    const { parseOpencodeOutput } = await import('../src/agents/cli');
    const stdout = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"type":"text","text":"OK"}}',
      '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":6421,"input":6317,"output":40,"reasoning":64,"cache":{"write":0,"read":10}},"cost":0.00178725}}',
    ].join('\n');
    const parsed = parseOpencodeOutput(stdout);
    expect(parsed.text).toBe('OK');
    expect(parsed.tokens).toEqual({ input: 6317, output: 104, cacheRead: 10, cacheWrite: 0 });
    expect(parsed.costUsd).toBeCloseTo(0.00178725);
  });
});

describe('parseClaudeResult', () => {
  it('finds the result message in the output array', () => {
    const stdout = JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', is_error: false, result: 'text', structured_output: { ok: true }, total_cost_usd: 0.5, num_turns: 3 },
    ]);
    const result = parseClaudeResult(stdout);
    expect(result.structured_output).toEqual({ ok: true });
    expect(result.total_cost_usd).toBe(0.5);
  });

  it('rejects non-JSON and result-less output', () => {
    expect(() => parseClaudeResult('garbage')).toThrow(/did not return JSON/);
    expect(() => parseClaudeResult('[{"type":"system"}]')).toThrow(/no result message/);
  });
});
