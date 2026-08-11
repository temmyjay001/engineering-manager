import { z } from 'zod';
import { invokeRole } from './agents/invoke';
import { MEETING_MAX_TURNS } from './config';
import type { Ctx } from './ctx';
import type { Meeting, MeetingMessage, Ticket } from './domain/types';

export const MEETING_ROLES = ['pm', 'planner', 'architect'] as const;
export const STAKEHOLDER = 'you';

const meetingReplyContract = z.object({
  reply: z.string().describe('Your contribution to the meeting, addressed to the participants'),
});

const minutesContract = z.object({
  summary: z.string().describe('Meeting minutes: decisions made and open questions, a short paragraph'),
  actionItems: z
    .array(
      z.object({
        title: z.string().describe('Short imperative title'),
        description: z.string().describe('A self-contained request a PM could turn into a ticket'),
        skip: z
          .boolean()
          .default(false)
          .describe('True if this action item already appears delivered or duplicates an existing ticket on the current board'),
        skipReason: z
          .enum(['already delivered', 'duplicate'])
          .nullable()
          .describe('Required when skip is true: why this action item is being skipped, otherwise null'),
        skipTicket: z.string().default('').describe('Key of the matching board ticket, when skip is true'),
      }),
    )
    .default([])
    .describe('Concrete work the meeting agreed on; empty if none'),
});

export function agentParticipants(meeting: Meeting): string[] {
  return meeting.participants.filter((p) => p !== STAKEHOLDER);
}

export function pickResponder(meeting: Meeting, text: string, addressed?: string | null): string {
  const agents = agentParticipants(meeting);
  if (agents.length === 0) throw new Error('this meeting has no agent participants');
  if (addressed) {
    if (!agents.includes(addressed)) throw new Error(`${addressed} is not in this meeting (${agents.join(', ')})`);
    return addressed;
  }
  const mention = /^@([a-z][a-z0-9-]*)/i.exec(text.trim());
  if (mention && agents.includes(mention[1]!.toLowerCase())) return mention[1]!.toLowerCase();
  return agents[0]!;
}

export function transcriptBlock(messages: MeetingMessage[]): string {
  if (messages.length === 0) return '(the meeting has just started)';
  return messages.map((m) => `[${m.speaker === STAKEHOLDER ? 'stakeholder' : m.speaker}] ${m.text}`).join('\n\n');
}

function linkedContext(ctx: Ctx, meeting: Meeting): string {
  const { store } = ctx;
  if (meeting.ticketId) {
    const t = store.getTicketById(meeting.ticketId);
    if (t) {
      const criteria = store.getCriteria(t.id).map((c) => `- ${c.text}`);
      return [
        `This meeting is about ticket ${t.key} (${t.status}): ${t.title || t.description.slice(0, 80)}`,
        `Request: ${t.description}`,
        criteria.length ? `Acceptance criteria:\n${criteria.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
  }
  if (meeting.epicId) {
    const e = store.getEpicById(meeting.epicId);
    if (e) {
      return [`This meeting is about epic ${e.key} (${e.status}): ${e.title}`, `Goal: ${e.description}`, e.plan ? `Current plan:\n${e.plan}` : '']
        .filter(Boolean)
        .join('\n');
    }
  }
  return 'This is a standalone meeting about the repository; explore the code when the discussion needs facts.';
}

function meetingPrompt(
  ctx: Ctx,
  meeting: Meeting,
  messages: MeetingMessage[],
  responder: string,
  restrictedTools: boolean,
): string {
  const others = meeting.participants.filter((p) => p !== responder && p !== STAKEHOLDER);
  return [
    `You are the ${responder} in a working meeting titled "${meeting.title}".`,
    `Participants: you (${responder}), the human stakeholder${others.length ? `, and the ${others.join(', ')}` : ''}.`,
    '',
    linkedContext(ctx, meeting),
    '',
    'Transcript so far:',
    transcriptBlock(messages),
    '',
    'Respond to the latest message as yourself. Be concrete and brief. Ask clarifying questions when requirements are ambiguous.',
    'Prioritize the transcript and linked context above over exploring the repository. If you need more detail, use targeted reads of specific files relevant to the question rather than an open-ended survey or search of the codebase.',
    restrictedTools
      ? 'The ticket title, description, and acceptance criteria are already given above; reuse them instead of re-deriving them. You have no repository tools this turn, so do not attempt to re-explore the project, and never speak for other participants.'
      : 'Ground claims about the codebase in what you can read, and never speak for other participants.',
  ].join('\n');
}

function meetingMaxTurns(ctx: Ctx): number {
  return ctx.project.config.meetingMaxTurns ?? MEETING_MAX_TURNS;
}

export function boardSnapshot(tickets: Ticket[]): string {
  if (tickets.length === 0) return '(the board has no tickets yet)';
  return tickets.map((t) => `${t.key} [${t.status}] ${t.title || '(untitled)'}`).join('\n');
}

export function draftOpeningMessage(item: { title: string; description: string }, meetingTitle: string): string {
  return [
    `This draft comes from an action item agreed in the meeting "${meetingTitle}".`,
    '',
    `**${item.title}**`,
    item.description,
    '',
    "Let's shape this into a ticket together; tell me if anything here needs to change.",
  ].join('\n');
}

export function composeMinutes(summary: string, created: Ticket[], skipNotes: string[]): string {
  const parts = [summary];
  if (created.length) parts.push(`Created drafts: ${created.map((t) => t.key).join(', ')}.`);
  parts.push(...skipNotes);
  return parts.join('\n\n');
}

export async function meetingTurn(
  ctx: Ctx,
  meetingId: number,
  text: string,
  addressed?: string | null,
): Promise<MeetingMessage> {
  const meeting = requireOpenMeeting(ctx, meetingId);
  const responder = pickResponder(meeting, text, addressed);
  ctx.store.addMeetingMessage(meeting.id, STAKEHOLDER, text);
  const messages = ctx.store.meetingMessages(meeting.id);
  const restrictedTools = responder === 'pm' && meeting.ticketId != null;
  const res = await invokeRole(ctx, {
    role: responder,
    model: ctx.project.config.meetingModel ?? undefined,
    prompt: meetingPrompt(ctx, meeting, messages, responder, restrictedTools),
    cwd: ctx.project.root,
    contract: meetingReplyContract,
    ticketId: meeting.ticketId ?? undefined,
    epicId: meeting.epicId ?? undefined,
    tools: restrictedTools ? [] : undefined,
    maxTurns: meetingMaxTurns(ctx),
  });
  return ctx.store.addMeetingMessage(meeting.id, responder, res.output.reply);
}

export interface MeetingOutcome {
  summary: string;
  createdTickets: Ticket[];
}

export async function concludeMeeting(ctx: Ctx, meetingId: number): Promise<MeetingOutcome> {
  const meeting = requireOpenMeeting(ctx, meetingId);
  const agents = agentParticipants(meeting);
  const chair = agents.includes('planner') ? 'planner' : (agents[0] ?? 'pm');
  const messages = ctx.store.meetingMessages(meeting.id);
  const prompt = [
    `The meeting "${meeting.title}" has ended. You are the ${chair} writing the minutes.`,
    '',
    linkedContext(ctx, meeting),
    '',
    'Current board (key [status] title):',
    boardSnapshot(ctx.store.listTickets()),
    '',
    'Transcript:',
    transcriptBlock(messages),
    '',
    'Summarize the decisions and open questions, and list the concrete action items the meeting agreed on.',
    'Only include action items that were actually agreed, not ideas that were raised and dropped.',
    'Check every action item against the current board above. If it already appears delivered or duplicates an existing ticket, set skip to true, pick the matching reason, and name the ticket in skipTicket instead of minting new work for it.',
    'Prioritize the transcript and linked context above over exploring the repository. If you need more detail, use targeted reads of specific files relevant to the discussion rather than an open-ended survey or search of the codebase.',
  ].join('\n');

  const res = await invokeRole(ctx, {
    role: chair,
    model: ctx.project.config.meetingModel ?? undefined,
    prompt,
    cwd: ctx.project.root,
    contract: minutesContract,
    ticketId: meeting.ticketId ?? undefined,
    epicId: meeting.epicId ?? undefined,
    maxTurns: meetingMaxTurns(ctx),
  });

  const createdTickets: Ticket[] = [];
  const skipNotes: string[] = [];
  for (const item of res.output.actionItems) {
    if (item.skip) {
      const reason = item.skipReason ?? 'duplicate';
      const ticketRef = item.skipTicket ? ` (${item.skipTicket})` : '';
      skipNotes.push(`Skipped "${item.title}" as ${reason}${ticketRef}.`);
      continue;
    }
    const ticket = ctx.store.createDraftTicket({ description: item.description });
    ctx.store.addDraftMessage(ticket.id, 'pm', draftOpeningMessage(item, meeting.title));
    createdTickets.push(ticket);
  }

  const summary = composeMinutes(res.output.summary, createdTickets, skipNotes);
  ctx.store.endMeeting(meeting.id, summary);
  return { summary, createdTickets };
}

function requireOpenMeeting(ctx: Ctx, meetingId: number): Meeting {
  const meeting = ctx.store.getMeeting(meetingId);
  if (!meeting) throw new Error(`no meeting ${meetingId}`);
  if (meeting.status !== 'OPEN') throw new Error(`meeting ${meetingId} has ended`);
  return meeting;
}

const WRITE_CAPABLE = new Set(['developer', 'uat']);

export function invitableRoles(pipeline: string[]): string[] {
  const custom = pipeline.filter((s) => !['pm', 'architect', 'developer', 'reviewer', 'uat'].includes(s));
  return [...new Set([...MEETING_ROLES, 'reviewer', ...custom])];
}

export function validateParticipants(participants: string[], pipeline: string[]): string | null {
  const agents = participants.filter((p) => p !== STAKEHOLDER);
  if (agents.length === 0) return 'invite at least one agent participant';
  const writers = agents.filter((p) => WRITE_CAPABLE.has(p));
  if (writers.length) return `${writers.join(', ')} cannot attend meetings; only read-only roles can`;
  const invitable = new Set(invitableRoles(pipeline));
  const unknown = agents.filter((p) => !invitable.has(p));
  if (unknown.length) return `unknown participants: ${unknown.join(', ')} (invitable: ${[...invitable].join(', ')})`;
  return null;
}
