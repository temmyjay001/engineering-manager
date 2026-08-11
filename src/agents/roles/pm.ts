import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../../ctx';
import type { GateResult, Ticket } from '../../domain/types';
import { attachmentsBlock } from '../context';
import { pmContract, pmDraftContract, type PmDraftOutput } from '../contracts';
import { invokeRole } from '../invoke';

export async function runPm(ctx: Ctx, ticket: Ticket, signal?: AbortSignal, activity?: (line: string) => void): Promise<GateResult> {
  const { store, project } = ctx;
  const parts = ['Turn this request into a ticket with acceptance criteria.', '', 'Request:', ticket.description];

  if (ticket.epicId) {
    const epic = store.getEpicById(ticket.epicId);
    if (epic) parts.push('', `This ticket is subticket ${ticket.seq} of epic ${epic.key}: ${epic.title}.`);
  }

  if (project.config.runCommand || project.config.appUrl) {
    parts.push(
      '',
      `Project config already records how the app runs: runCommand ${project.config.runCommand ?? '(unset)'}, appUrl ${project.config.appUrl ?? '(unset)'}. Prefer these over re-deriving them.`,
    );
  }

  const guidance = store.latestArtifact(ticket.id, 'GUIDANCE')?.content ?? null;
  if (guidance) parts.push('', 'Stakeholder guidance on how to proceed:', guidance);

  const prior = store.latestArtifact(ticket.id, 'TICKET')?.content ?? null;
  const isRevision = Boolean(prior && ticket.feedback);

  if (!isRevision) {
    const attachments = attachmentsBlock(store, project, ticket);
    if (attachments) parts.push('', attachments);
  }

  if (prior && ticket.feedback) {
    parts.push(
      '',
      'Your previous ticket draft:',
      prior,
      '',
      'Revise it to address this feedback specifically:',
      ticket.feedback,
      '',
      'That draft already carries the title, description, and acceptance criteria; reuse them as your starting point and change only what the feedback requires. You have no repository tools this turn, so do not try to re-explore the project; everything you need is above.',
    );
  }

  const res = await invokeRole(ctx, {
    role: 'pm',
    attempt: ticket.attempt,
    prompt: parts.join('\n'),
    cwd: project.root,
    contract: pmContract,
    ticketId: ticket.id,
    signal,
    onActivity: activity,
    tools: isRevision ? [] : undefined,
  });
  const out = res.output;

  store.setTitle(ticket.id, out.title);
  store.setUiInfo(
    ticket.id,
    out.hasUi,
    out.runCommand ?? project.config.runCommand,
    out.appUrl ?? project.config.appUrl,
  );
  store.setCriteria(ticket.id, out.acceptanceCriteria);
  if (ticket.feedback) store.setFeedback(ticket.id, null);

  return { verdict: 'PASS', summary: out.summary, artifact: { kind: 'TICKET', content: res.text, data: out } };
}

export interface PmDraftAttachment {
  name: string;
  content: string;
}

export interface PmDraftMessage {
  speaker: string;
  text: string;
}

export async function runPmDraft(
  ctx: Ctx,
  rawIdea: string,
  attachments: PmDraftAttachment[] = [],
  messages: PmDraftMessage[] = [],
  signal?: AbortSignal,
  activity?: (line: string) => void,
): Promise<PmDraftOutput> {
  const { project } = ctx;
  const parts = [
    'Draft a proposed ticket from this idea: a title, acceptance criteria, a priority, and labels.',
    'If anything is ambiguous or missing, ask clarifying questions in your reply; leave reply empty if you have none.',
    '',
    'Idea:',
    rawIdea,
  ];

  if (messages.length > 0) {
    parts.push('', 'Side conversation so far:', messages.map((m) => `[${m.speaker}] ${m.text}`).join('\n\n'));
  }

  if (attachments.length > 0) {
    const dir = join(project.scratchDir, 'pm-draft', 'attachments');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const lines = attachments.map((a, i) => {
      const path = join(dir, `${i}-${a.name.replaceAll('/', '_')}`);
      writeFileSync(path, Buffer.from(a.content, 'base64'));
      return `- ${a.name}: ${path}`;
    });
    parts.push(
      '',
      'The stakeholder attached images to this idea (screenshots, mockups, or diagrams).',
      'View them with your file reading tool before deciding; they are part of the request:',
      ...lines,
    );
  }

  const res = await invokeRole(ctx, {
    role: 'pm-draft',
    prompt: parts.join('\n'),
    cwd: project.root,
    contract: pmDraftContract,
    signal,
    onActivity: activity,
  });

  return res.output;
}
