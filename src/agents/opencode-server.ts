import { spawn } from 'node:child_process';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from '../config';
import { composeTextPrompt } from './cli';
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

const HEALTH_DEADLINE_MS = 20_000;
const ATTACH_DEADLINE_MS = 5_000;
const RUN_TIMEOUT_MS = 30 * 60_000;
const FIRST_STEP_STALL_MS = 90_000;

export interface ModelRef {
  providerID: string;
  id: string;
}

export function parseModelRef(model: string): ModelRef {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`opencode-server models use the "provider/model" format, got "${model}"`);
  }
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

export interface SessionEvent {
  type?: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface TurnState {
  steps: number;
  finish: string | null;
  failure: string | null;
  texts: string[];
  tokens: AgentTokens;
  costUsd: number;
}

export interface TurnUpdate {
  done: boolean;
  activity?: string;
  permissionId?: string;
}

export function newTurnState(): TurnState {
  return { steps: 0, finish: null, failure: null, texts: [], tokens: emptyTokens(), costUsd: 0 };
}

function preview(value: unknown, max = 120): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function applyEvent(state: TurnState, event: SessionEvent): TurnUpdate {
  const p = (event.properties ?? event.data ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'session.next.tool.called':
      return { done: false, activity: `${String(p.tool ?? 'tool')} ${preview(p.input)}` };
    case 'session.next.tool.failed':
      return { done: false, activity: `${String(p.tool ?? 'tool')} failed` };
    case 'session.next.text.ended': {
      if (typeof p.text === 'string' && p.text.trim()) state.texts.push(p.text);
      return { done: false };
    }
    case 'session.next.step.ended': {
      state.steps += 1;
      const tokens = (p.tokens ?? {}) as Record<string, any>;
      state.tokens.input += tokens.input ?? 0;
      state.tokens.output += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
      state.tokens.cacheRead += tokens.cache?.read ?? 0;
      state.tokens.cacheWrite += tokens.cache?.write ?? 0;
      state.costUsd += typeof p.cost === 'number' ? p.cost : 0;
      const finish = typeof p.finish === 'string' ? p.finish : 'unknown';
      if (finish === 'tool-calls') return { done: false };
      state.finish = finish;
      return { done: true, activity: `turn finished (${finish})` };
    }
    case 'session.next.step.failed':
    case 'session.error': {
      state.failure = preview(p.error ?? p.message ?? p, 300);
      return { done: true };
    }
    case 'session.status': {
      const status = (p.status ?? {}) as Record<string, unknown>;
      if (status.type === 'retry') {
        return { done: false, activity: `provider retry: ${preview(status.message ?? '', 100)}` };
      }
      return { done: false };
    }
    case 'permission.v2.asked':
    case 'permission.asked': {
      const id = typeof p.id === 'string' ? p.id : undefined;
      return { done: false, permissionId: id, activity: `permission auto-approved: ${String(p.action ?? p.type ?? 'request')}` };
    }
    default:
      return { done: false };
  }
}

class SessionStallError extends AgentRunFailedError {}

interface ManagedServer {
  baseUrl: string;
}

let managed: Promise<ManagedServer> | null = null;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolvePort(port) : reject(new Error('could not allocate a port'))));
    });
  });
}

async function healthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(baseUrl: string, deadlineMs: number, alive?: () => boolean): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (alive && !alive()) break;
    if (await healthy(baseUrl)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`opencode server at ${baseUrl} is not responding`);
}

async function spawnManaged(): Promise<ManagedServer> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    stdio: 'ignore',
    env: process.env,
  });
  let exited = false;
  child.on('error', () => {
    exited = true;
  });
  child.on('exit', () => {
    exited = true;
    managed = null;
  });
  child.unref();
  const kill = () => {
    if (!exited) child.kill('SIGTERM');
  };
  process.once('exit', kill);
  try {
    await waitHealthy(baseUrl, HEALTH_DEADLINE_MS, () => !exited);
  } catch {
    kill();
    throw new Error(
      'Failed to start an opencode server ("opencode serve"). Is the opencode CLI installed and on PATH? ' +
        'Alternatively set opencodeServerUrl in .em/config.json to attach to one you manage.',
    );
  }
  return { baseUrl };
}

export async function ensureOpencodeServer(url: string | null): Promise<string> {
  if (url) {
    const baseUrl = url.replace(/\/$/, '');
    await waitHealthy(baseUrl, ATTACH_DEADLINE_MS).catch(() => {
      throw new Error(
        `Cannot reach the opencode server at ${baseUrl} (opencodeServerUrl). ` +
          'Start it with "opencode serve" (with your provider keys in its environment), or unset opencodeServerUrl to let em manage one.',
      );
    });
    return baseUrl;
  }
  if (!managed) {
    managed = spawnManaged().catch((err) => {
      managed = null;
      throw err;
    });
  }
  return (await managed).baseUrl;
}

async function api<T = any>(baseUrl: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`opencode server ${method} ${path} failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

interface AssistantMessage {
  type?: string;
  error?: unknown;
  parts?: Array<{ type?: string; text?: string }>;
}

function assistantText(messages: AssistantMessage[]): string {
  const assistants = messages.filter((m) => m.type === 'assistant');
  const last = assistants.at(-1);
  if (!last) return '';
  return (last.parts ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n\n');
}

export class OpencodeServerRunner implements AgentRunner {
  readonly id = 'opencode-server';
  readonly enforcesReadOnly = false;
  readonly supportsMcp = false;

  constructor(private readonly serverUrl: string | null) {}

  async run<T>(job: AgentJob<T>): Promise<AgentOutcome<T>> {
    if (job.browser) {
      throw new Error(
        'Runner "opencode-server" has no browser support; keep browser-dependent roles (uat) on claude-sdk or a browser-capable runner',
      );
    }
    const attempts = 2;
    let lastError = 'unknown error';
    let partial = emptyTokens();
    let partialCostUsd = 0;
    for (let i = 1; i <= attempts; i++) {
      if (job.signal?.aborted) throw new AgentAbortedError(job.role, partial, partialCostUsd);
      try {
        return await this.once(job, i);
      } catch (err) {
        if (err instanceof AgentRunFailedError || err instanceof AgentAbortedError) {
          partial = mergeTokens(partial, err.tokens);
          partialCostUsd += err.costUsd ?? 0;
        }
        if (err instanceof AgentAbortedError || job.signal?.aborted) throw new AgentAbortedError(job.role, partial, partialCostUsd);
        if (err instanceof AgentIdleTimeoutError) throw new AgentIdleTimeoutError(err.idleMinutes, partial, partialCostUsd);
        if (err instanceof SessionStallError) throw new AgentRunFailedError(err.message, partial, partialCostUsd);
        lastError = (err as Error).message;
      }
    }
    throw new AgentRunFailedError(
      `Agent "${job.role}" via runner "${this.id}" failed after ${attempts} attempts: ${lastError}`,
      partial,
      partialCostUsd,
    );
  }

  private async once<T>(job: AgentJob<T>, attempt: number): Promise<AgentOutcome<T>> {
    const started = Date.now();
    const baseUrl = await ensureOpencodeServer(this.serverUrl);
    const model = parseModelRef(job.model);
    const created = await api(baseUrl, 'POST', '/api/session', {
      model,
      location: { directory: job.cwd },
    });
    const sid: string = created.data.id;

    const sse = new AbortController();
    const onAbort = () => sse.abort();
    job.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => sse.abort(), RUN_TIMEOUT_MS);
    let stalled = false;
    const stallTimer = setTimeout(() => {
      stalled = true;
      sse.abort();
    }, FIRST_STEP_STALL_MS);
    const idleMinutes = job.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
    let idledOut = false;
    const watchdog = startIdleWatchdog(idleMinutes, () => {
      idledOut = true;
      sse.abort();
    });

    const state = newTurnState();
    try {
      // The server flushes SSE response headers only with the first event, so the
      // stream must not be awaited before the prompt is sent (that would deadlock).
      const streamPromise = this.openStream(`${baseUrl}/api/session/${sid}/event`, sse.signal);
      streamPromise.catch(() => undefined);

      await api(baseUrl, 'POST', `/api/session/${sid}/prompt`, {
        prompt: { text: composeTextPrompt(job, attempt > 1) },
      });

      const events = this.readEvents(await streamPromise);
      for await (const event of events) {
        watchdog.touch();
        if (event.type === 'session.next.step.started') clearTimeout(stallTimer);
        const update = applyEvent(state, event);
        if (update.activity) job.onActivity?.(update.activity);
        if (update.permissionId) {
          await api(baseUrl, 'POST', `/api/session/${sid}/permission/${update.permissionId}/reply`, {
            reply: 'once',
          }).catch(() => undefined);
        }
        if (update.done) break;
      }
    } catch (err) {
      await api(baseUrl, 'POST', `/api/session/${sid}/interrupt`).catch(() => undefined);
      if (job.signal?.aborted) throw new AgentAbortedError(job.role, state.tokens, state.costUsd);
      if (idledOut) throw new AgentIdleTimeoutError(idleMinutes, state.tokens, state.costUsd);
      if (stalled) throw new SessionStallError(await this.diagnoseStall(baseUrl, sid), state.tokens, state.costUsd);
      if (sse.signal.aborted) {
        throw new AgentRunFailedError(
          `opencode-server run timed out after ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes`,
          state.tokens,
          state.costUsd,
        );
      }
      if (err instanceof AgentRunFailedError || err instanceof AgentAbortedError) throw err;
      throw new AgentRunFailedError((err as Error).message, state.tokens, state.costUsd);
    } finally {
      clearTimeout(timer);
      clearTimeout(stallTimer);
      watchdog.stop();
      job.signal?.removeEventListener('abort', onAbort);
      sse.abort();
    }

    if (job.signal?.aborted) {
      await api(baseUrl, 'POST', `/api/session/${sid}/interrupt`).catch(() => undefined);
      throw new AgentAbortedError(job.role, state.tokens, state.costUsd);
    }
    if (state.failure) throw new AgentRunFailedError(`opencode session failed: ${state.failure}`, state.tokens, state.costUsd);

    let text = state.texts.join('\n\n');
    if (!text.trim()) {
      const msgs = await api(baseUrl, 'GET', `/api/session/${sid}/message`);
      const messages: AssistantMessage[] = msgs.data ?? [];
      const errored = messages.find((m) => m.type === 'assistant' && m.error);
      if (errored) {
        throw new AgentRunFailedError(`opencode session failed: ${preview(errored.error, 300)}`, state.tokens, state.costUsd);
      }
      text = assistantText(messages);
    }

    const output = job.contract.parse(extractJson(text));
    return {
      output,
      text,
      costUsd: state.costUsd,
      numTurns: state.steps,
      durationMs: Date.now() - started,
      tokens: state.tokens,
    };
  }

  private async diagnoseStall(baseUrl: string, sid: string): Promise<string> {
    const generic =
      `opencode session made no progress within ${Math.round(FIRST_STEP_STALL_MS / 1000)}s. ` +
      'The server usually cannot resolve the model in this state: make sure the opencode server process has your ' +
      'provider keys in its environment (em passes its own env, including the project .env, to managed servers) ' +
      'and that the model id is valid for the provider.';
    try {
      const msgs = await api(baseUrl, 'GET', `/api/session/${sid}/message`);
      const messages: AssistantMessage[] = msgs.data ?? [];
      const errored = messages.find((m) => m.type === 'assistant' && m.error);
      if (errored) return `opencode session failed: ${preview(errored.error, 300)}`;
    } catch {
      /* server unreachable; fall through to the generic diagnosis */
    }
    return generic;
  }

  private openStream(url: string, signal: AbortSignal): Promise<IncomingMessage> {
    // node:http instead of fetch: the request must be on the wire while the response
    // headers are still pending, and undici resolves nothing until headers arrive.
    return new Promise((resolvePromise, reject) => {
      const req = httpGet(url, { signal }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`opencode server event stream failed (${res.statusCode ?? 'no status'})`));
          return;
        }
        resolvePromise(res);
      });
      req.on('error', reject);
    });
  }

  private async *readEvents(stream: IncomingMessage): AsyncGenerator<SessionEvent> {
    let buffer = '';
    for await (const chunk of stream) {
      buffer += (chunk as Buffer).toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (!payload.startsWith('{')) continue;
        try {
          yield JSON.parse(payload) as SessionEvent;
        } catch {
          /* partial or malformed frame */
        }
      }
    }
  }
}
