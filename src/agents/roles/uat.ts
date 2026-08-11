import type { Ctx } from '../../ctx';
import type { GateResult, Ticket } from '../../domain/types';
import { scratchPath, worktreePath } from '../../git/worktree';
import { criteriaBlock, latest, ticketBlock } from '../context';
import { uatContract } from '../contracts';
import { collectNewEvidence, snapshotFiles } from '../evidence';
import { invokeRole } from '../invoke';

export async function runUat(ctx: Ctx, ticket: Ticket, signal?: AbortSignal, activity?: (line: string) => void): Promise<GateResult> {
  const { store, project } = ctx;
  const plan = latest(store, ticket, 'PLAN');
  const scratch = scratchPath(project, ticket.key);
  const uiCriteriaCount = store.getCriteria(ticket.id).filter((c) => c.isUi).length;

  const runCommand = ticket.runCommand ?? project.config.runCommand;
  const appUrl = ticket.appUrl ?? project.config.appUrl;
  const runInfo = ticket.hasUi
    ? [
        `This ticket has a UI. Start the app with: ${runCommand ?? '(unknown, find it)'}`,
        `Then drive a browser to: ${appUrl ?? '(unknown, find it)'}`,
        `Screenshot budget: save at most one piece of visual evidence per UI criterion (${uiCriteriaCount} total). For a criterion that verifies textual content (text values, labels, status values, headers), take an accessibility snapshot and save its text instead of an image. For a criterion that verifies non-textual content (visual layout, graphics, complex controls), save a single screenshot image. Never save more than one per criterion.`,
      ].join('\n')
    : 'This ticket has no UI. Verify every criterion through the shell.';

  const prompt = [
    ticketBlock(ticket),
    '',
    'Acceptance criteria to verify (one result per index):',
    criteriaBlock(store, ticket),
    '',
    runInfo,
    '',
    `Evidence directory (absolute path, outside the repo): ${scratch}`,
    'Save screenshots, accessibility snapshots, and captured output there, never into the repo checkout.',
    '',
    'Implementation plan (for context only, the criteria are the contract):',
    plan ?? '(no plan recorded)',
  ].join('\n');

  const before = snapshotFiles(scratch);
  const res = await invokeRole(ctx, {
    role: 'uat',
    attempt: ticket.attempt,
    prompt,
    cwd: worktreePath(project, ticket.key),
    contract: uatContract,
    browser: ticket.hasUi,
    writableDirs: [scratch],
    confineReads: true,
    ticketId: ticket.id,
    signal,
    onActivity: activity,
  });
  const out = res.output;

  for (const item of collectNewEvidence(scratch, before, uiCriteriaCount)) {
    store.addArtifact(ticket.id, 'EVIDENCE', 'uat', item.content, { name: item.name, mime: item.mime });
  }

  store.setCriteriaResults(
    ticket.id,
    out.results.map((r) => ({ idx: r.idx, met: r.met })),
  );

  return {
    verdict: out.verdict,
    summary: out.summary,
    artifact: { kind: 'UAT', content: res.text, data: out },
    criteria: out.results.map((r) => ({ idx: r.idx, met: r.met, note: r.evidence })),
  };
}
