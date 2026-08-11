import type { Ctx } from '../../ctx';
import type { GateResult, Ticket } from '../../domain/types';
import { scratchPath, worktreePath } from '../../git/worktree';
import { attachmentsBlock, criteriaBlock, latest, latestDefect, ticketBlock } from '../context';
import { developerContract } from '../contracts';
import { invokeRole } from '../invoke';

export async function runDeveloper(ctx: Ctx, ticket: Ticket, signal?: AbortSignal, activity?: (line: string) => void): Promise<GateResult> {
  const { store, project } = ctx;
  const plan = latest(store, ticket, 'PLAN');
  const defect = ticket.status === 'IN_PROGRESS' ? latestDefect(store, ticket) : null;
  const scratch = scratchPath(project, ticket.key);

  const parts = [
    ticketBlock(ticket),
    '',
    'Acceptance criteria (the contract, do not change):',
    criteriaBlock(store, ticket),
    '',
    'Implementation plan:',
    plan ?? '(no plan recorded)',
    '',
    `Scratch directory (absolute path, outside the repo): ${scratch}`,
    'Anything that is not part of the change itself (notes, logs, temp files) goes there, never into the repo.',
  ];

  const attachments = attachmentsBlock(store, project, ticket);
  if (attachments) parts.push('', attachments);

  if (defect) {
    parts.push(
      '',
      defect.kind === 'GUIDANCE'
        ? 'This is a rework pass. A human unblocked this ticket with the following guidance; follow it:'
        : `This is a rework pass. The previous attempt failed ${defect.kind}. Fix exactly these defects:`,
      defect.content,
    );
  }

  const res = await invokeRole(ctx, {
    role: 'developer',
    attempt: ticket.attempt,
    prompt: parts.join('\n'),
    cwd: worktreePath(project, ticket.key),
    contract: developerContract,
    writableDirs: [scratch],
    ticketId: ticket.id,
    signal,
    onActivity: activity,
  });
  const out = res.output;
  const summary = out.notes ? `${out.summary} (notes: ${out.notes})` : out.summary;

  return { verdict: out.verdict, summary };
}
