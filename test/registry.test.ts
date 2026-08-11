import { describe, expect, it } from 'vitest';
import { AcpRunner } from '../src/agents/acp';
import { CliRunner } from '../src/agents/cli';
import { OpencodeServerRunner } from '../src/agents/opencode-server';
import { availableRunnerIds, cliSpecFor, resolveRunner } from '../src/agents/registry';
import { parseCliRunnerSpec, type EmConfig } from '../src/project';

const emptyConfig = {
  runCommand: null,
  appUrl: null,
  mergeStrategy: 'merge',
  opencodeServerUrl: null,
  roles: {},
  runners: {},
} as EmConfig;

describe('runner registry', () => {
  it('defaults to the SDK runner', () => {
    expect(resolveRunner(emptyConfig).id).toBe('claude-sdk');
    expect(resolveRunner(emptyConfig, 'claude-sdk').enforcesReadOnly).toBe(true);
  });

  it('ships built-in presets for claude-cli, codex, gemini, and opencode', () => {
    for (const id of ['claude-cli', 'codex', 'gemini', 'opencode']) {
      const runner = resolveRunner(emptyConfig, id);
      expect(runner).toBeInstanceOf(CliRunner);
      expect(runner.id).toBe(id);
    }
    expect(cliSpecFor(emptyConfig, 'codex')?.command).toBe('codex');
    expect(cliSpecFor(emptyConfig, 'gemini')?.command).toBe('gemini');
    expect(cliSpecFor(emptyConfig, 'opencode')?.command).toBe('opencode');
  });

  it('only claude runners enforce read-only among the presets', () => {
    expect(resolveRunner(emptyConfig, 'claude-cli').enforcesReadOnly).toBe(true);
    expect(resolveRunner(emptyConfig, 'codex').enforcesReadOnly).toBe(false);
    expect(resolveRunner(emptyConfig, 'gemini').enforcesReadOnly).toBe(false);
    expect(resolveRunner(emptyConfig, 'opencode').enforcesReadOnly).toBe(false);
  });

  it('lets config runners extend and shadow presets', () => {
    const config = {
      ...emptyConfig,
      runners: {
        mycli: parseCliRunnerSpec({ command: 'mycli' }),
        codex: parseCliRunnerSpec({ command: '/opt/custom/codex' }),
      },
    } as EmConfig;
    expect(cliSpecFor(config, 'mycli')?.command).toBe('mycli');
    expect(cliSpecFor(config, 'codex')?.command).toBe('/opt/custom/codex');
    expect(availableRunnerIds(config)).toContain('mycli');
  });

  it('resolves the opencode-server runner', () => {
    const runner = resolveRunner(emptyConfig, 'opencode-server');
    expect(runner).toBeInstanceOf(OpencodeServerRunner);
    expect(runner.id).toBe('opencode-server');
    expect(runner.enforcesReadOnly).toBe(false);
    expect(availableRunnerIds(emptyConfig)).toContain('opencode-server');
  });

  it('routes acp-kind specs to the ACP runner', () => {
    expect(resolveRunner(emptyConfig, 'gemini-acp')).toBeInstanceOf(AcpRunner);
    const custom = {
      ...emptyConfig,
      runners: { zeddy: parseCliRunnerSpec({ kind: 'acp', command: 'zed-agent' }) },
    } as EmConfig;
    const runner = resolveRunner(custom, 'zeddy');
    expect(runner).toBeInstanceOf(AcpRunner);
    expect(runner.supportsMcp).toBe(true);
  });

  it('rejects unknown runner ids with the available list', () => {
    expect(() => resolveRunner(emptyConfig, 'nope')).toThrow(
      /Available: claude-sdk, opencode-server, claude-cli, codex, gemini, opencode, gemini-acp/,
    );
  });
});
