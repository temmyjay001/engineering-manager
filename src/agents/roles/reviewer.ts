import type { Ctx } from '../../ctx';
import type { GateResult, Ticket } from '../../domain/types';
import { diffStat, worktreePath } from '../../git/worktree';
import { criteriaBlock, latest, ticketBlock } from '../context';
import { reviewerContract } from '../contracts';
import { invokeRole } from '../invoke';

const DIFF_PROMPT_LIMIT = 40_000;

export async function runReviewer(ctx: Ctx, ticket: Ticket, signal?: AbortSignal, activity?: (line: string) => void): Promise<GateResult> {
  const { store, project } = ctx;
  const plan = latest(store, ticket, 'PLAN');
  const fullDiff = latest(store, ticket, 'DIFF') ?? '(no diff captured)';

  const diffBlock =
    fullDiff.length <= DIFF_PROMPT_LIMIT
      ? ['Diff under review (changes since the worktree base):', fullDiff]
      : [
          'The diff exceeds the inline size threshold; it is excluded here. Summary of changed files (diffstat):',
          ticket.baseSha ? diffStat(project, ticket.key, ticket.baseSha) : '(no diff stat available)',
          '',
          'The worktree contains the final state. Do targeted reads of each file listed above instead of the full diff; do not explore the rest of the repository.',
        ];

  const prompt = [
    ticketBlock(ticket),
    '',
    'Acceptance criteria:',
    criteriaBlock(store, ticket),
    '',
    'Implementation plan:',
    plan ?? '(no plan recorded)',
    '',
    ...diffBlock,
  ].join('\n');

  const res = await invokeRole(ctx, {
    role: 'reviewer',
    attempt: ticket.attempt,
    prompt,
    cwd: worktreePath(project, ticket.key),
    contract: reviewerContract,
    confineReads: true,
    ticketId: ticket.id,
    signal,
    onActivity: activity,
  });
  const out = res.output;

  return { verdict: out.verdict, summary: out.summary, artifact: { kind: 'REVIEW', content: res.text, data: out } };
}
