import { spawn, type ChildProcess } from 'node:child_process';
import { DEFAULT_IDLE_TIMEOUT_MINUTES, READ_ONLY_TOOLS, ROLE_TOOLS } from '../config';
import type { CliRunnerSpec } from '../project';
import { contractInstructions, extractJson } from './extract';
import {
  AgentAbortedError,
  AgentIdleTimeoutError,
  AgentRunFailedError,
  emptyTokens,
  mergeTokens,
  startIdleWatchdog,
  toApiSchema,
  type AgentJob,
  type AgentOutcome,
  type AgentRunner,
  type AgentTokens,
} from './runner';

const OUTPUT_LIMIT = 32 * 1024 * 1024;

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
}

class CliAbortedError extends Error {}

function runProcess(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    input?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    idleTimeoutMinutes?: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) {
      reject(new CliAbortedError(`${command} cancelled`));
      return;
    }
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const idleMinutes = opts.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
    const watchdog = startIdleWatchdog(idleMinutes, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(child);
      reject(new AgentIdleTimeoutError(idleMinutes));
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      killProcessTree(child);
      reject(new Error(`${command} timed out after ${Math.round(opts.timeoutMs / 60000)} minutes`));
    }, opts.timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watchdog.stop();
      killProcessTree(child);
      reject(new CliAbortedError(`${command} cancelled`));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      watchdog.touch();
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      watchdog.touch();
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watchdog.stop();
      reject(new Error(`failed to start ${command}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watchdog.stop();
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise({ stdout, stderr, code: code ?? 1 });
    });

    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

interface ClaudeResultMessage {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  errors?: string[];
}

function tokensFromClaudeUsage(usage?: ClaudeResultMessage['usage']): AgentTokens {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
  };
}

export function parseClaudeResult(stdout: string): ClaudeResultMessage {
  let messages: unknown;
  try {
    messages = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI did not return JSON output: ${stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(messages)) throw new Error('claude CLI output is not a message array');
  const result = (messages as ClaudeResultMessage[]).find((m) => m.type === 'result');
  if (!result) throw new Error('claude CLI output contains no result message');
  return result;
}

export interface ParsedCliOutput {
  text: string;
  tokens?: AgentTokens;
  costUsd?: number;
}

function jsonLines(stdout: string): unknown[] {
  const events: unknown[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* interleaved non-JSON noise */
    }
  }
  return events;
}

export function parseCodexOutput(stdout: string): ParsedCliOutput {
  const texts: string[] = [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  for (const event of jsonLines(stdout) as Array<Record<string, any>>) {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      texts.push(event.item.text);
    }
    if (event.type === 'turn.completed' && event.usage) {
      input += event.usage.input_tokens ?? 0;
      output += (event.usage.output_tokens ?? 0) + (event.usage.reasoning_output_tokens ?? 0);
      cacheRead += event.usage.cached_input_tokens ?? 0;
    }
  }
  return { text: texts.join('\n\n'), tokens: { input, output, cacheRead, cacheWrite: 0 } };
}

export function parseGeminiOutput(stdout: string): ParsedCliOutput {
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`gemini did not return JSON output: ${stdout.slice(0, 200)}`);
  }
  let input = 0;
  let output = 0;
  const models = parsed.stats?.models ?? {};
  for (const stats of Object.values(models) as Array<Record<string, any>>) {
    const tokens = stats?.tokens ?? {};
    input += tokens.prompt ?? 0;
    output += (tokens.candidates ?? 0) + (tokens.thoughts ?? 0);
  }
  return { text: typeof parsed.response === 'string' ? parsed.response : '', tokens: { input, output, cacheRead: 0, cacheWrite: 0 } };
}

export function parseOpencodeOutput(stdout: string): ParsedCliOutput {
  const texts: string[] = [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costUsd = 0;
  for (const event of jsonLines(stdout) as Array<Record<string, any>>) {
    const part = event.part ?? {};
    if (event.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    if (part.type === 'step-finish') {
      const tokens = part.tokens ?? {};
      input += tokens.input ?? 0;
      output += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
      cacheRead += tokens.cache?.read ?? 0;
      cacheWrite += tokens.cache?.write ?? 0;
      costUsd += part.cost ?? 0;
    }
  }
  return { text: texts.join('\n\n'), tokens: { input, output, cacheRead, cacheWrite }, costUsd };
}

function parseRawText(stdout: string): ParsedCliOutput {
  return { text: stdout };
}

const TEXT_PARSERS: Record<string, (stdout: string) => ParsedCliOutput> = {
  generic: parseRawText,
  codex: parseCodexOutput,
  gemini: parseGeminiOutput,
  opencode: parseOpencodeOutput,
};

function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Unknown placeholder {${key}} in runner args`);
    return value;
  });
}

export function composeTextPrompt<T>(job: AgentJob<T>, strictRetry: boolean): string {
  return [
    'For this task you are acting in the following role. It defines your responsibilities and constraints; work within them.',
    '',
    'ROLE:',
    job.systemPrompt,
    '',
    'TASK:',
    job.prompt,
    contractInstructions(toApiSchema(job.contract), strictRetry),
  ].join('\n');
}

export class CliRunner implements AgentRunner {
  constructor(
    readonly id: string,
    private readonly spec: CliRunnerSpec,
  ) {}

  get command(): string {
    return this.spec.command;
  }

  get enforcesReadOnly(): boolean {
    return this.spec.kind === 'claude' || this.spec.enforcesReadOnly;
  }

  get supportsMcp(): boolean {
    return this.spec.kind === 'claude';
  }

  async run<T>(job: AgentJob<T>): Promise<AgentOutcome<T>> {
    if (job.browser && !this.spec.browser) {
      throw new Error(
        `Runner "${this.id}" has no browser support; keep browser-dependent roles (uat) on claude-sdk or a browser-capable runner`,
      );
    }
    const attempts = 2;
    let lastError = 'unknown error';
    let partial = emptyTokens();
    let partialCostUsd = 0;
    for (let i = 1; i <= attempts; i++) {
      if (job.signal?.aborted) throw new AgentAbortedError(job.role, partial, partialCostUsd);
      try {
        const outcome = this.spec.kind === 'claude' ? await this.onceClaude(job) : await this.onceText(job, i);
        if (outcome) return outcome;
        lastError = 'agent finished without producing a structured result';
      } catch (err) {
        if (err instanceof AgentRunFailedError) {
          partial = mergeTokens(partial, err.tokens);
          partialCostUsd += err.costUsd ?? 0;
        }
        if (err instanceof CliAbortedError || job.signal?.aborted) throw new AgentAbortedError(job.role, partial, partialCostUsd);
        if (err instanceof AgentIdleTimeoutError) throw new AgentIdleTimeoutError(err.idleMinutes, partial, partialCostUsd);
        lastError = (err as Error).message;
      }
    }
    throw new AgentRunFailedError(
      `Agent "${job.role}" via runner "${this.id}" failed after ${attempts} attempts: ${lastError}`,
      partial,
      partialCostUsd,
    );
  }

  private async onceClaude<T>(job: AgentJob<T>): Promise<AgentOutcome<T> | null> {
    const started = Date.now();
    const tools = (job.tools ?? (ROLE_TOOLS as Record<string, string[]>)[job.role] ?? READ_ONLY_TOOLS).join(',');
    const mcpNames = Object.keys(job.mcpServers ?? {});
    const allowedTools = [tools, ...mcpNames.map((name) => `mcp__${name}`)].join(',');
    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(toApiSchema(job.contract)),
      '--model',
      job.model,
      '--max-turns',
      String(job.maxTurns),
      '--system-prompt',
      job.systemPrompt,
      '--tools',
      tools,
      '--allowed-tools',
      allowedTools,
      '--strict-mcp-config',
      '--no-session-persistence',
      ...(mcpNames.length ? ['--mcp-config', JSON.stringify({ mcpServers: job.mcpServers })] : []),
      ...(job.writableDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
      ...this.spec.args,
    ];
    const proc = await this.exec(args, job.prompt, job.cwd, job.signal, job.idleTimeoutMinutes);
    const result = parseClaudeResult(proc.stdout);
    if (result.subtype !== 'success' || result.is_error) {
      const detail = result.errors?.length ? `: ${result.errors.join('; ')}` : '';
      throw new AgentRunFailedError(
        `claude CLI run ended with ${result.subtype ?? 'unknown'}${detail}`,
        tokensFromClaudeUsage(result.usage),
        result.total_cost_usd ?? 0,
      );
    }
    if (result.structured_output === undefined) return null;
    const output = job.contract.parse(result.structured_output);
    return {
      output,
      text: result.result?.trim() ? result.result : JSON.stringify(output, null, 2),
      costUsd: result.total_cost_usd ?? 0,
      numTurns: result.num_turns ?? 0,
      durationMs: Date.now() - started,
      tokens: tokensFromClaudeUsage(result.usage),
    };
  }

  private async onceText<T>(job: AgentJob<T>, attempt: number): Promise<AgentOutcome<T> | null> {
    const started = Date.now();
    const prompt = composeTextPrompt(job, attempt > 1);
    const values = {
      model: job.model,
      maxTurns: String(job.maxTurns),
      prompt,
    };
    const usesPromptArg = this.spec.args.some((a) => a.includes('{prompt}'));
    const args = this.spec.args.map((a) => substitute(a, values));
    if (!usesPromptArg && this.spec.promptVia === 'arg') args.push(prompt);
    const input = !usesPromptArg && this.spec.promptVia === 'stdin' ? prompt : undefined;

    const proc = await this.exec(args, input, job.cwd, job.signal, job.idleTimeoutMinutes);
    const parsed = (TEXT_PARSERS[this.spec.kind] ?? parseRawText)(proc.stdout);
    let output: T;
    try {
      output = job.contract.parse(extractJson(parsed.text));
    } catch (err) {
      throw new AgentRunFailedError((err as Error).message, parsed.tokens, parsed.costUsd);
    }
    return {
      output,
      text: parsed.text,
      costUsd: parsed.costUsd ?? 0,
      numTurns: 0,
      durationMs: Date.now() - started,
      tokens: parsed.tokens,
    };
  }

  private async exec(
    args: string[],
    input: string | undefined,
    cwd: string,
    signal?: AbortSignal,
    idleTimeoutMinutes?: number,
  ): Promise<ProcessResult> {
    const proc = await runProcess(this.spec.command, args, {
      cwd,
      input,
      env: this.spec.env,
      timeoutMs: this.spec.timeoutMinutes * 60_000,
      idleTimeoutMinutes,
      signal,
    });
    if (proc.code !== 0) {
      throw new Error(`${this.spec.command} exited with code ${proc.code}: ${proc.stderr.slice(-500)}`);
    }
    return proc;
  }
}
