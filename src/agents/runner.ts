import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { query, type CanUseTool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { DEFAULT_IDLE_TIMEOUT_MINUTES, PLAYWRIGHT_MCP, PLAYWRIGHT_TOOLS, READ_ONLY_TOOLS, ROLE_TOOLS } from '../config';
import type { McpServerSpec } from '../project';

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'format',
  'default',
]);

const NAME_MAP_KEYS = new Set(['properties', '$defs', 'definitions', 'patternProperties']);

function stripUnsupported(node: unknown, isNameMap = false): unknown {
  if (Array.isArray(node)) return node.map((item) => stripUnsupported(item));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!isNameMap && UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
      out[key] = stripUnsupported(value, !isNameMap && NAME_MAP_KEYS.has(key));
    }
    return out;
  }
  return node;
}

export function toApiSchema(contract: z.ZodType): Record<string, unknown> {
  return stripUnsupported(z.toJSONSchema(contract)) as Record<string, unknown>;
}

export interface AgentJob<T> {
  role: string;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  contract: z.ZodType<T>;
  browser?: boolean;
  writableDirs?: string[];
  confineReads?: boolean;
  model: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
  onActivity?: (line: string) => void;
  mcpServers?: Record<string, McpServerSpec>;
  tools?: string[];
  idleTimeoutMinutes?: number;
}

export interface AgentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyTokens(): AgentTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function mergeTokens(a: AgentTokens, b?: AgentTokens): AgentTokens {
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** A failed or cancelled agent run that may still carry token usage from completed or attempted turns. */
export class AgentRunFailedError extends Error {
  constructor(
    message: string,
    readonly tokens?: AgentTokens,
    readonly costUsd?: number,
    readonly servingModel?: string,
  ) {
    super(message);
  }
}

export class AgentAbortedError extends Error {
  constructor(
    role: string,
    readonly tokens?: AgentTokens,
    readonly costUsd?: number,
    readonly servingModel?: string,
  ) {
    super(`Agent "${role}" was cancelled`);
  }
}

/** Thrown when a run produces no activity (messages, tool calls, stream events) for the idle window. */
export class AgentIdleTimeoutError extends AgentRunFailedError {
  constructor(
    readonly idleMinutes: number,
    tokens?: AgentTokens,
    costUsd?: number,
    servingModel?: string,
  ) {
    super(`idle timeout: no activity for ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'}`, tokens, costUsd, servingModel);
  }
}

export interface IdleWatchdog {
  /** Reset the idle window; call on every sign of life (stream events, log lines, tool calls). */
  touch(): void;
  /** Stop the watchdog once the run has finished, one way or another. */
  stop(): void;
}

/** A reusable idle-silence timer: fires onIdle if touch() isn't called for idleMinutes. */
export function startIdleWatchdog(idleMinutes: number, onIdle: () => void): IdleWatchdog {
  let timer = setTimeout(onIdle, idleMinutes * 60_000);
  return {
    touch() {
      clearTimeout(timer);
      timer = setTimeout(onIdle, idleMinutes * 60_000);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

function mirrorSignal(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

export interface AgentOutcome<T> {
  output: T;
  text: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  tokens?: AgentTokens;
  servingModel?: string;
}

export interface AgentRunner {
  readonly id: string;
  readonly enforcesReadOnly: boolean;
  readonly supportsMcp: boolean;
  run<T>(job: AgentJob<T>): Promise<AgentOutcome<T>>;
}

class NonRetryableError extends AgentRunFailedError {}

// Resolve the deepest existing ancestor's realpath so a symlink under an
// allowed directory cannot smuggle the target outside it; the not-yet-existing
// tail (a file about to be written) is appended back unresolved.
function realpathDeep(path: string): string {
  let base = path;
  let tail = '';
  for (;;) {
    try {
      return tail ? join(realpathSync(base), tail) : realpathSync(base);
    } catch {
      const parent = dirname(base);
      if (parent === base) return path;
      tail = tail ? join(basename(base), tail) : basename(base);
      base = parent;
    }
  }
}

function within(path: string, dirs: string[]): boolean {
  const real = realpathDeep(path);
  return dirs.some((dir) => {
    const rel = relative(realpathDeep(dir), real);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

const PATH_INPUT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const CONFINABLE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

export interface BoundaryDecision {
  behavior: 'allow' | 'deny';
  path?: string;
}

export function boundaryDecision(
  cwd: string,
  allowedDirs: string[],
  toolName: string,
  input: Record<string, unknown>,
  blockedPath?: string,
  confineReads = false,
): BoundaryDecision {
  if (blockedPath && !within(resolve(cwd, blockedPath), allowedDirs)) {
    return { behavior: 'deny', path: blockedPath };
  }
  if (PATH_INPUT_TOOLS.has(toolName) || (confineReads && CONFINABLE_READ_TOOLS.has(toolName))) {
    const raw = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof raw === 'string' && !within(resolve(cwd, raw), allowedDirs)) {
      return { behavior: 'deny', path: raw };
    }
  }
  return { behavior: 'allow' };
}

export function boundaryGuard(job: AgentJob<unknown>): CanUseTool {
  const allowedDirs = [job.cwd, ...(job.writableDirs ?? []), tmpdir()];
  return async (toolName, input, options) => {
    const decision = boundaryDecision(job.cwd, allowedDirs, toolName, input, options.blockedPath, job.confineReads);
    if (decision.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: `${decision.path} is outside your workspace. Work only under: ${allowedDirs.join(', ')}`,
      };
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

export class ClaudeSdkRunner implements AgentRunner {
  readonly id = 'claude-sdk';
  readonly enforcesReadOnly = true;
  readonly supportsMcp = true;

  async run<T>(job: AgentJob<T>): Promise<AgentOutcome<T>> {
    const attempts = 2;
    let lastError = 'unknown error';
    let partial = emptyTokens();
    let partialCostUsd = 0;
    for (let i = 1; i <= attempts; i++) {
      if (job.signal?.aborted) throw new AgentAbortedError(job.role, partial, partialCostUsd);
      try {
        const outcome = await this.once(job);
        if (outcome) return outcome;
        lastError = 'agent finished without producing a structured result';
      } catch (err) {
        if (err instanceof AgentRunFailedError) {
          partial = mergeTokens(partial, err.tokens);
          partialCostUsd += err.costUsd ?? 0;
        }
        if (job.signal?.aborted) throw new AgentAbortedError(job.role, partial, partialCostUsd);
        if (err instanceof AgentIdleTimeoutError) throw new AgentIdleTimeoutError(err.idleMinutes, partial, partialCostUsd);
        if (err instanceof NonRetryableError) {
          throw new AgentRunFailedError(`Agent "${job.role}" failed: ${err.message}`, partial, partialCostUsd);
        }
        lastError = (err as Error).message;
      }
    }
    throw new AgentRunFailedError(`Agent "${job.role}" failed after ${attempts} attempts: ${lastError}`, partial, partialCostUsd);
  }

  private async once<T>(job: AgentJob<T>): Promise<AgentOutcome<T> | null> {
    const started = Date.now();
    const roleTools = job.tools ?? (ROLE_TOOLS as Record<string, string[]>)[job.role] ?? READ_ONLY_TOOLS;
    const abortController = mirrorSignal(job.signal);
    const options: Options = {
      model: job.model,
      cwd: job.cwd,
      systemPrompt: job.systemPrompt,
      abortController,
      tools: roleTools,
      allowedTools: [
        // allowedTools are auto-approved and never reach canUseTool; confined
        // roles must leave read tools off the list so the boundary guard runs.
        ...(job.confineReads ? [] : READ_ONLY_TOOLS.filter((t) => roleTools.includes(t))),
        ...(job.browser ? PLAYWRIGHT_TOOLS : []),
        ...Object.keys(job.mcpServers ?? {}).map((name) => `mcp__${name}`),
      ],
      permissionMode: 'default',
      canUseTool: boundaryGuard(job),
      ...(job.writableDirs?.length ? { additionalDirectories: job.writableDirs } : {}),
      maxTurns: job.maxTurns,
      ...(job.maxBudgetUsd ? { maxBudgetUsd: job.maxBudgetUsd } : {}),
      outputFormat: { type: 'json_schema', schema: toApiSchema(job.contract) },
      persistSession: false,
      ...(job.browser || job.mcpServers
        ? { mcpServers: { ...(job.browser ? { playwright: PLAYWRIGHT_MCP } : {}), ...job.mcpServers } }
        : {}),
    };

    const idleMinutes = job.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
    let idledOut = false;
    let streamTokens = emptyTokens();
    const watchdog = startIdleWatchdog(idleMinutes, () => {
      idledOut = true;
      abortController.abort();
    });
    try {
      for await (const message of query({ prompt: job.prompt, options })) {
        watchdog.touch();
        if (message.type === 'assistant' && message.message.usage) {
          streamTokens = mergeTokens(streamTokens, tokensFromUsage(message.message.usage));
        }
        if (message.type !== 'result') continue;
        const tokens = tokensFromUsage(message.usage);
        if (message.subtype === 'success') {
          return this.successOutcome(job, message, started, tokens);
        }
        const detail = message.errors.length ? `: ${message.errors.join('; ')}` : '';
        const costUsd = message.total_cost_usd ?? 0;
        if (message.subtype === 'error_max_budget_usd') {
          throw new NonRetryableError(`run exceeded its budget of $${job.maxBudgetUsd}${detail}`, tokens, costUsd);
        }
        throw new AgentRunFailedError(`agent run ended with ${message.subtype}${detail}`, tokens, costUsd);
      }
      return null;
    } catch (err) {
      if (idledOut) throw new AgentIdleTimeoutError(idleMinutes, streamTokens);
      throw err;
    } finally {
      watchdog.stop();
    }
  }

  private successOutcome<T>(
    job: AgentJob<T>,
    message: {
      structured_output?: unknown;
      result: string;
      total_cost_usd: number;
      num_turns: number;
    },
    started: number,
    tokens: AgentTokens,
  ): AgentOutcome<T> | null {
    if (message.structured_output === undefined) return null;
    const output = job.contract.parse(message.structured_output);
    return {
      output,
      text: message.result,
      costUsd: message.total_cost_usd ?? 0,
      numTurns: message.num_turns ?? 0,
      durationMs: Date.now() - started,
      tokens,
    };
  }
}

function tokensFromUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): AgentTokens {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

