import { parseCliRunnerSpec, type CliRunnerSpec, type EmConfig } from '../project';
import { AcpRunner } from './acp';
import { CliRunner } from './cli';
import { OpencodeServerRunner } from './opencode-server';
import { ClaudeSdkRunner, type AgentRunner } from './runner';

const sdkRunner = new ClaudeSdkRunner();

const BUILTIN_CLI_SPECS: Record<string, CliRunnerSpec> = {
  'claude-cli': parseCliRunnerSpec({ kind: 'claude', command: 'claude' }),
  codex: parseCliRunnerSpec({
    kind: 'codex',
    command: 'codex',
    args: [
      'exec',
      '--json',
      '--model',
      '{model}',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--ephemeral',
      '-',
    ],
  }),
  gemini: parseCliRunnerSpec({
    kind: 'gemini',
    command: 'gemini',
    args: [
      '--model',
      '{model}',
      '--approval-mode',
      'yolo',
      '--skip-trust',
      '--output-format',
      'json',
      '--prompt',
      'Follow the task instructions provided on stdin.',
    ],
  }),
  opencode: parseCliRunnerSpec({
    kind: 'opencode',
    command: 'opencode',
    args: ['run', '--model', '{model}', '--auto', '--format', 'json', '{prompt}'],
  }),
  'gemini-acp': parseCliRunnerSpec({
    kind: 'acp',
    command: 'gemini',
    args: ['--acp', '--model', '{model}'],
  }),
};

export function availableRunnerIds(config: EmConfig): string[] {
  return ['claude-sdk', 'opencode-server', ...Object.keys(BUILTIN_CLI_SPECS), ...Object.keys(config.runners)];
}

export function cliSpecFor(config: EmConfig, id: string): CliRunnerSpec | undefined {
  return config.runners[id] ?? BUILTIN_CLI_SPECS[id];
}

export function resolveRunner(config: EmConfig, runnerId = 'claude-sdk'): AgentRunner {
  if (runnerId === 'claude-sdk') return sdkRunner;
  if (runnerId === 'opencode-server') return new OpencodeServerRunner(config.opencodeServerUrl);
  const spec = cliSpecFor(config, runnerId);
  if (spec) return spec.kind === 'acp' ? new AcpRunner(runnerId, spec) : new CliRunner(runnerId, spec);
  throw new Error(`Unknown agent runner "${runnerId}". Available: ${availableRunnerIds(config).join(', ')}`);
}
