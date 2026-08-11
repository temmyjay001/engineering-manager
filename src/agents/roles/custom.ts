import type { Ctx } from '../../ctx';
import type { GateResult, Ticket } from '../../domain/types';
import { diffStat, worktreePath } from '../../git/worktree';
import { criteriaBlock, latest, ticketBlock } from '../context';
import { customGateContract } from '../contracts';
import { invokeRole } from '../invoke';

const DIFF_PROMPT_LIMIT = 200_000;

export async function runCustomGate(
  ctx: Ctx,
  ticket: Ticket,
  gate: string,
  signal?: AbortSignal,
  activity?: (line: string) => void,
): Promise<GateResult> {
  const { store, project } = ctx;
  const fullDiff = latest(store, ticket, 'DIFF') ?? '(no diff captured)';

  const diffBlock =
    fullDiff.length <= DIFF_PROMPT_LIMIT
      ? ['Diff under review (changes since the worktree base):', fullDiff]
      : [
          'The diff is too large to inline. Summary of changed files:',
          ticket.baseSha ? diffStat(project, ticket.key, ticket.baseSha) : '(no diff stat available)',
          '',
          'The worktree contains the final state. Review every file listed above by reading it in full.',
        ];

  const prompt = [
    ticketBlock(ticket),
    '',
    'Acceptance criteria:',
    criteriaBlock(store, ticket),
    '',
    ...diffBlock,
  ].join('\n');

  const res = await invokeRole(ctx, {
    role: gate,
    prompt,
    cwd: worktreePath(project, ticket.key),
    contract: customGateContract,
    confineReads: true,
    ticketId: ticket.id,
    signal,
    onActivity: activity,
  });
  const out = res.output;

  return { verdict: out.verdict, summary: out.summary, artifact: { kind: 'REVIEW', content: res.text, data: out } };
}
