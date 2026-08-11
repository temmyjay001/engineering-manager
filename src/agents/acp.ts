import { spawn, type ChildProcess } from 'node:child_process';
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from '../config';
import type { CliRunnerSpec, McpServerSpec } from '../project';
import { composeTextPrompt, killProcessTree } from './cli';
import { extractJson } from './extract';
import {
  AgentAbortedError,
  AgentIdleTimeoutError,
  AgentRunFailedError,
  emptyTokens,
  mergeTokens,
  startIdleWatchdog,
  type AgentJob,
  type AgentOutcome,
  type AgentRunner,
  type AgentTokens,
} from './runner';

const PROTOCOL_VERSION = 1;
const CANCEL_GRACE_MS = 5_000;

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export function pickPermissionOption(options: AcpPermissionOption[]): string | null {
  const byKind = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
  return byKind('allow_once') ?? byKind('allow_always') ?? null;
}

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export function toAcpMcpServers(servers: Record<string, McpServerSpec> | undefined): AcpMcpServer[] {
  if (!servers) return [];
  const out: AcpMcpServer[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (!('command' in spec)) {
      throw new Error(`MCP server "${name}" is remote (${spec.type}); ACP agents accept stdio MCP servers only`);
    }
    out.push({
      name,
      command: spec.command,
      args: spec.args,
      env: Object.entries(spec.env).map(([key, value]) => ({ name: key, value })),
    });
  }
  return out;
}

export interface SessionUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  title?: string;
  kind?: string;
  status?: string;
}

export interface AcpTurn {
  text: string;
  toolCalls: number;
}

export function applyUpdate(turn: AcpTurn, update: SessionUpdate): string | undefined {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content?.type === 'text' && typeof update.content.text === 'string') {
        turn.text += update.content.text;
      }
      return undefined;
    }
    case 'tool_call': {
      turn.toolCalls += 1;
      return `${update.kind ?? 'tool'}: ${update.title ?? '(untitled)'}`;
    }
    case 'tool_call_update': {
      return update.status === 'failed' ? `tool failed: ${update.title ?? ''}`.trim() : undefined;
    }
    default:
      return undefined;
  }
}

interface AcpQuota {
  tokens: AgentTokens;
  servingModel?: string;
}

export function quotaFromResult(result: any): AcpQuota {
  const quota = result?._meta?.quota;
  if (!quota) return { tokens: emptyTokens() };
  const modelUsage: Array<{ model?: string; token_count?: { input_tokens?: number; output_tokens?: number } }> =
    Array.isArray(quota.model_usage) ? quota.model_usage : [];
  const servingModel = modelUsage
    .filter((entry): entry is { model: string; token_count?: { input_tokens?: number; output_tokens?: number } } =>
      typeof entry.model === 'string',
    )
    .reduce<{ model?: string; total: number }>(
      (best, entry) => {
        const total = (entry.token_count?.input_tokens ?? 0) + (entry.token_count?.output_tokens ?? 0);
        return total > best.total ? { model: entry.model, total } : best;
      },
      { model: undefined, total: -1 },
    ).model;
  const totalCount = quota.token_count ?? {};
  let input = totalCount.input_tokens ?? 0;
  let output = totalCount.output_tokens ?? 0;
  if (!input && !output && modelUsage.length > 0) {
    for (const entry of modelUsage) {
      input += entry.token_count?.input_tokens ?? 0;
      output += entry.token_count?.output_tokens ?? 0;
    }
  }
  return { tokens: { input, output, cacheRead: 0, cacheWrite: 0 }, servingModel };
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';

  constructor(
    private readonly child: ChildProcess,
    private readonly onNotification: (method: string, params: any) => void,
    private readonly onRequest: (method: string, params: any) => Promise<unknown>,
  ) {
    child.stdout?.on('data', (chunk: Buffer) => this.feed(chunk.toString('utf8')));
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      if (!this.child.stdin?.write(`${payload}\n`)) {
        this.pending.delete(id);
        reject(new Error('ACP agent stdin is not writable'));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  failAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private feed(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line.startsWith('{')) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: any): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new RpcError(message.error.code ?? 0, message.error.message ?? 'ACP error'));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.onRequest(message.method, message.params)
        .then((result) => this.reply(message.id, { result }))
        .catch((err: Error) =>
          this.reply(message.id, {
            error: { code: err instanceof RpcError ? err.code : -32603, message: err.message },
          }),
        );
      return;
    }
    if (message.method) this.onNotification(message.method, message.params);
  }

  private reply(id: unknown, body: { result?: unknown; error?: unknown }): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
  }
}

function substituteArgs(args: string[], values: Record<string, string>): string[] {
  return args.map((arg) =>
    arg.replace(/\{(\w+)\}/g, (whole, key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Unknown placeholder {${key}} in runner args`);
      return value;
    }),
  );
}

export class AcpRunner implements AgentRunner {
  readonly enforcesReadOnly: boolean;
  readonly supportsMcp = true;

  constructor(
    readonly id: string,
    private readonly spec: CliRunnerSpec,
  ) {
    this.enforcesReadOnly = spec.enforcesReadOnly;
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
    let partialServingModel: string | undefined;
    for (let i = 1; i <= attempts; i++) {
      if (job.signal?.aborted) throw new AgentAbortedError(job.role, partial, undefined, partialServingModel);
      try {
        const outcome = await this.once(job, i);
        return {
          ...outcome,
          tokens: mergeTokens(partial, outcome.tokens),
          servingModel: outcome.servingModel ?? partialServingModel,
        };
      } catch (err) {
        if (err instanceof AgentRunFailedError || err instanceof AgentAbortedError) {
          partial = mergeTokens(partial, err.tokens);
          partialServingModel = err.servingModel ?? partialServingModel;
        }
        if (err instanceof AgentAbortedError || job.signal?.aborted) {
          throw new AgentAbortedError(job.role, partial, undefined, partialServingModel);
        }
        if (err instanceof AgentIdleTimeoutError) {
          throw new AgentIdleTimeoutError(err.idleMinutes, partial, undefined, partialServingModel);
        }
        lastError = (err as Error).message;
      }
    }
    throw new AgentRunFailedError(
      `Agent "${job.role}" via runner "${this.id}" failed after ${attempts} attempts: ${lastError}`,
      partial,
      undefined,
      partialServingModel,
    );
  }

  private async once<T>(job: AgentJob<T>, attempt: number): Promise<AgentOutcome<T>> {
    const started = Date.now();
    const args = substituteArgs(this.spec.args, { model: job.model, maxTurns: String(job.maxTurns) });
    const child = spawn(this.spec.command, args, {
      cwd: job.cwd,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
    });

    const idleMinutes = job.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
    let idledOut = false;
    let capturedQuota: AcpQuota = { tokens: emptyTokens() };
    const watchdog = startIdleWatchdog(idleMinutes, () => {
      idledOut = true;
      cancel();
    });
    child.stdout?.on('data', () => watchdog.touch());
    child.stderr?.on('data', () => watchdog.touch());

    const turn: AcpTurn = { text: '', toolCalls: 0 };
    let sessionId: string | null = null;

    const peer = new JsonRpcPeer(
      child,
      (method, params) => {
        if (method !== 'session/update' || params?.sessionId !== sessionId) return;
        const line = applyUpdate(turn, (params.update ?? {}) as SessionUpdate);
        if (line) job.onActivity?.(line);
      },
      async (method, params) => {
        if (method === 'session/request_permission') {
          const optionId = pickPermissionOption((params?.options ?? []) as AcpPermissionOption[]);
          if (!optionId) return { outcome: { outcome: 'cancelled' } };
          job.onActivity?.(`permission auto-approved: ${params?.toolCall?.title ?? 'tool call'}`);
          return { outcome: { outcome: 'selected', optionId } };
        }
        throw new RpcError(-32601, `Client method not supported: ${method}`);
      },
    );

    const exited = new Promise<void>((resolvePromise) => {
      child.on('exit', () => {
        peer.failAll(new Error(`ACP agent exited before the turn finished: ${stderr.slice(-400) || '(no stderr)'}`));
        resolvePromise();
      });
    });
    child.on('error', (err) => peer.failAll(new Error(`failed to start ${this.spec.command}: ${err.message}`)));

    const cancel = () => {
      if (sessionId) peer.notify('session/cancel', { sessionId });
      setTimeout(() => killProcessTree(child), CANCEL_GRACE_MS).unref();
    };
    const onAbort = () => cancel();
    job.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(cancel, this.spec.timeoutMinutes * 60_000);

    try {
      const init = await peer.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      if (typeof init?.protocolVersion !== 'number') {
        throw new Error(`ACP agent returned an invalid initialize response: ${JSON.stringify(init).slice(0, 200)}`);
      }

      let session: any;
      try {
        session = await peer.request('session/new', {
          cwd: job.cwd,
          mcpServers: toAcpMcpServers(job.mcpServers),
        });
      } catch (err) {
        if (err instanceof RpcError && err.code === -32000) {
          throw new Error(
            `ACP agent "${this.spec.command}" requires authentication. Log in with the agent's own CLI first, then retry.`,
          );
        }
        throw err;
      }
      sessionId = session?.sessionId;
      if (!sessionId) throw new Error('ACP agent created no session');

      const result = await peer.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: composeTextPrompt(job, attempt > 1) }],
      });
      const quota = quotaFromResult(result);
      capturedQuota = quota;

      if (idledOut) {
        throw new AgentIdleTimeoutError(idleMinutes, quota.tokens, undefined, quota.servingModel);
      }
      if (job.signal?.aborted || result?.stopReason === 'cancelled') {
        throw new AgentAbortedError(job.role, quota.tokens, undefined, quota.servingModel);
      }
      if (result?.stopReason !== 'end_turn' && result?.stopReason !== 'max_turn_requests') {
        throw new AgentRunFailedError(
          `ACP turn ended with ${result?.stopReason ?? 'no stop reason'}: ${turn.text.slice(-300)}`,
          quota.tokens,
          undefined,
          quota.servingModel,
        );
      }

      let output: T;
      try {
        output = job.contract.parse(extractJson(turn.text));
      } catch (err) {
        throw new AgentRunFailedError((err as Error).message, quota.tokens, undefined, quota.servingModel);
      }
      return {
        output,
        text: turn.text,
        costUsd: 0,
        numTurns: turn.toolCalls,
        durationMs: Date.now() - started,
        tokens: quota.tokens,
        servingModel: quota.servingModel,
      };
    } catch (err) {
      if (idledOut && !(err instanceof AgentIdleTimeoutError)) {
        throw new AgentIdleTimeoutError(idleMinutes, capturedQuota.tokens, undefined, capturedQuota.servingModel);
      }
      throw err;
    } finally {
      watchdog.stop();
      clearTimeout(timer);
      job.signal?.removeEventListener('abort', onAbort);
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2_000))]);
      if (child.exitCode === null && child.signalCode === null) killProcessTree(child);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }
}
