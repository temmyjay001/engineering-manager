import type { Ctx } from '../../ctx';
import type { GateResult, Ticket } from '../../domain/types';
import { worktreePath } from '../../git/worktree';
import { criteriaBlock, ticketBlock } from '../context';
import { architectContract } from '../contracts';
import { invokeRole } from '../invoke';

export async function runArchitect(ctx: Ctx, ticket: Ticket, signal?: AbortSignal, activity?: (line: string) => void): Promise<GateResult> {
  const guidance = ctx.store.latestArtifact(ticket.id, 'GUIDANCE')?.content ?? null;
  const prompt = [
    ticketBlock(ticket),
    '',
    'Approved acceptance criteria (fixed, your plan must satisfy all of them):',
    criteriaBlock(ctx.store, ticket),
    ...(guidance ? ['', 'Stakeholder guidance on how to proceed:', guidance] : []),
    '',
    'Produce the implementation plan.',
  ].join('\n');

  const res = await invokeRole(ctx, {
    role: 'architect',
    attempt: ticket.attempt,
    prompt,
    cwd: worktreePath(ctx.project, ticket.key),
    contract: architectContract,
    ticketId: ticket.id,
    signal,
    onActivity: activity,
  });
  const out = res.output;
  const summary = out.verdict === 'FAIL' ? `${out.summary} Blockers: ${out.blockers.join('; ')}` : out.summary;

  return { verdict: out.verdict, summary, artifact: { kind: 'PLAN', content: res.text, data: out } };
}
