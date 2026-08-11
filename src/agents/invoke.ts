import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  CUSTOM_GATE_MAX_TURNS,
  DEFAULT_MODEL,
  READ_ONLY_TOOLS,
  ROLE_MAX_TURNS,
  ROLE_MODELS,
  ROLE_TOOLS,
} from '../config';
import type { Ctx } from '../ctx';
import { currentRunTrace } from '../otel';
import { estimateCostUsd } from '../pricing';
import { loadConventions } from './conventions';
import { snapshotTree, treeChanges } from './guard';
import { resolveMcpServers } from './mcp';
import { resolveRunner } from './registry';
import { AgentAbortedError, AgentRunFailedError, type AgentOutcome, type AgentTokens } from './runner';

const here = dirname(fileURLToPath(import.meta.url));

function systemPromptFor(role: string, emDir: string): string {
  try {
    return readFileSync(join(here, 'prompts', `${role}.md`), 'utf8');
  } catch {
    /* not a built-in role; look for a project-defined one */
  }
  const projectPrompt = join(emDir, 'roles', `${role}.md`);
  try {
    return readFileSync(projectPrompt, 'utf8');
  } catch {
    throw new Error(`Custom pipeline stage "${role}" needs a role prompt at ${projectPrompt}`);
  }
}

export interface InvokeOpts<T> {
  role: string;
  attempt?: number;
  model?: string;
  prompt: string;
  cwd: string;
  contract: z.ZodType<T>;
  browser?: boolean;
  writableDirs?: string[];
  confineReads?: boolean;
  ticketId?: number;
  epicId?: number;
  signal?: AbortSignal;
  onActivity?: (line: string) => void;
  tools?: string[];
  maxTurns?: number;
}

export function modelForAttempt(
  overrides: { model?: string; escalation?: string[] },
  role: string,
  attempt: number,
  explicit?: string,
): string {
  if (explicit) return explicit;
  const ladder = overrides.escalation;
  if (ladder && ladder.length > 0) return ladder[Math.min(attempt, ladder.length - 1)]!;
  return overrides.model ?? (ROLE_MODELS as Record<string, string>)[role] ?? DEFAULT_MODEL;
}

const SLOT_POLL_MS = 1000;

async function acquireSlotOrWait(
  ctx: Ctx,
  kind: string,
  limit: number,
  role: string,
  signal?: AbortSignal,
  onActivity?: (line: string) => void,
): Promise<number> {
  let waited = false;
  for (;;) {
    if (signal?.aborted) throw new AgentAbortedError(role);
    const slot = ctx.store.acquireSlot(kind, limit);
    if (slot !== null) return slot;
    if (!waited) {
      waited = true;
      onActivity?.(`waiting for a free ${kind} slot (${limit} allowed at once)`);
    }
    await new Promise((r) => setTimeout(r, SLOT_POLL_MS));
  }
}

export async function invokeRole<T>(ctx: Ctx, opts: InvokeOpts<T>): Promise<AgentOutcome<T>> {
  const overrides = ctx.project.config.roles[opts.role] ?? {};
  const runner = resolveRunner(ctx.project.config, overrides.runner);
  const model = modelForAttempt(overrides, opts.role, opts.attempt ?? 0, opts.model);
  const mcpServers = resolveMcpServers(ctx.project.config, opts.role);
  if (mcpServers && !runner.supportsMcp) {
    throw new Error(
      `Role "${opts.role}" requests MCP servers (${Object.keys(mcpServers).join(', ')}) but runner "${runner.id}" cannot receive them per-run. ` +
        'Use claude-sdk or claude-cli for this role, or configure MCP in that runner\'s own config and remove the role\'s mcpServers list.',
    );
  }
  const tools = opts.tools ?? (ROLE_TOOLS as Record<string, string[]>)[opts.role] ?? READ_ONLY_TOOLS;
  const readOnlyRole = !tools.includes('Write');
  const guard = readOnlyRole && !runner.enforcesReadOnly ? snapshotTree(opts.cwd) : null;
  const conventions = loadConventions(ctx.project.config.conventionFiles, opts.cwd);
  const agentSlot = await acquireSlotOrWait(
    ctx,
    'agent',
    ctx.project.config.maxConcurrentAgents,
    opts.role,
    opts.signal,
    opts.onActivity,
  );
  let browserSlot: number | null = null;
  const started = Date.now();
  try {
    if (opts.browser) {
      browserSlot = await acquireSlotOrWait(ctx, 'browser', 1, opts.role, opts.signal, opts.onActivity);
    }
    const outcome = await runner.run({
      role: opts.role,
      prompt: conventions ? `${opts.prompt}\n\n${conventions}` : opts.prompt,
      systemPrompt: systemPromptFor(opts.role, ctx.project.emDir),
      cwd: opts.cwd,
      contract: opts.contract,
      browser: opts.browser,
      writableDirs: opts.writableDirs,
      confineReads: opts.confineReads,
      model,
      maxTurns: opts.maxTurns ?? overrides.maxTurns ?? (ROLE_MAX_TURNS as Record<string, number>)[opts.role] ?? CUSTOM_GATE_MAX_TURNS,
      maxBudgetUsd: overrides.maxBudgetUsd,
      signal: opts.signal,
      onActivity: opts.onActivity,
      mcpServers,
      tools,
      idleTimeoutMinutes: ctx.project.config.idleTimeoutMinutes,
    });
    if (guard) {
      const changed = treeChanges(opts.cwd, guard);
      if (changed.length > 0) {
        throw new Error(
          `Read-only role "${opts.role}" modified the working tree via runner "${runner.id}": ${changed.join(', ')}. Revert these changes and use a runner that enforces read-only for this role.`,
        );
      }
    }
    let costUsd = outcome.costUsd;
    if (costUsd === 0 && outcome.tokens) {
      costUsd = (await estimateCostUsd(ctx.project, outcome.servingModel ?? model, outcome.tokens)) ?? 0;
    }
    ctx.store.recordAgentRun({
      ticketId: opts.ticketId,
      epicId: opts.epicId,
      role: opts.role,
      runner: runner.id,
      model: outcome.servingModel ?? model,
      status: 'OK',
      costUsd,
      numTurns: outcome.numTurns,
      durationMs: outcome.durationMs,
      inputTokens: outcome.tokens?.input,
      outputTokens: outcome.tokens?.output,
      cacheReadTokens: outcome.tokens?.cacheRead,
      cacheWriteTokens: outcome.tokens?.cacheWrite,
    });
    currentRunTrace()?.addSpan({
      name: `agent.${opts.role}`,
      startMs: started,
      endMs: Date.now(),
      attributes: {
        'em.role': opts.role,
        'em.runner': runner.id,
        'em.model': model,
        'em.cost_usd': costUsd,
        'em.num_turns': outcome.numTurns,
        'em.tokens.input': outcome.tokens?.input ?? 0,
        'em.tokens.output': outcome.tokens?.output ?? 0,
        'em.tokens.cache_read': outcome.tokens?.cacheRead ?? 0,
        'em.tokens.cache_write': outcome.tokens?.cacheWrite ?? 0,
      },
    });
    return { ...outcome, costUsd };
  } catch (err) {
    const knownError = err instanceof AgentRunFailedError || err instanceof AgentAbortedError ? err : undefined;
    const tokens: AgentTokens | undefined = knownError?.tokens;
    const servingModel = knownError?.servingModel;
    let partialCostUsd = knownError?.costUsd ?? 0;
    if (partialCostUsd === 0 && tokens) {
      partialCostUsd = (await estimateCostUsd(ctx.project, servingModel ?? model, tokens)) ?? 0;
    }
    ctx.store.recordAgentRun({
      ticketId: opts.ticketId,
      epicId: opts.epicId,
      role: opts.role,
      runner: runner.id,
      model: servingModel ?? model,
      status: 'ERROR',
      costUsd: partialCostUsd,
      numTurns: 0,
      durationMs: Date.now() - started,
      inputTokens: tokens?.input,
      outputTokens: tokens?.output,
      cacheReadTokens: tokens?.cacheRead,
      cacheWriteTokens: tokens?.cacheWrite,
      error: (err as Error).message,
    });
    currentRunTrace()?.addSpan({
      name: `agent.${opts.role}`,
      startMs: started,
      endMs: Date.now(),
      attributes: {
        'em.role': opts.role,
        'em.runner': runner.id,
        'em.model': model,
        'em.cost_usd': partialCostUsd,
        'em.tokens.input': tokens?.input ?? 0,
        'em.tokens.output': tokens?.output ?? 0,
        'em.tokens.cache_read': tokens?.cacheRead ?? 0,
        'em.tokens.cache_write': tokens?.cacheWrite ?? 0,
      },
      error: (err as Error).message,
    });
    throw err;
  } finally {
    if (browserSlot !== null) ctx.store.releaseSlot(browserSlot);
    ctx.store.releaseSlot(agentSlot);
  }
}
