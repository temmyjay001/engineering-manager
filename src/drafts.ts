import { z } from 'zod';
import { invokeRole } from './agents/invoke';
import type { Ctx } from './ctx';
import type { Ticket, TicketDraftMessage } from './domain/types';

const draftReplyContract = z.object({
  reply: z.string().describe('Your reply to the stakeholder as the PM, continuing to shape the draft request'),
});

export function draftTranscript(messages: TicketDraftMessage[]): string {
  if (messages.length === 0) return '(the draft conversation has just started)';
  return messages.map((m) => `[${m.sender === 'pm' ? 'pm' : 'stakeholder'}] ${m.text}`).join('\n\n');
}

function draftPrompt(ticket: Ticket, messages: TicketDraftMessage[]): string {
  return [
    'You are the PM helping a stakeholder shape a draft request before it becomes a ticket.',
    '',
    `The draft so far is titled "${ticket.title || '(untitled)'}".`,
    ticket.description ? `Initial request: ${ticket.description}` : 'The stakeholder has not written a request yet.',
    '',
    'Conversation so far:',
    draftTranscript(messages),
    '',
    'Respond to the latest message as the PM. Be concrete and brief, and ask clarifying questions when the request is ambiguous.',
    'Ground claims about the codebase in what you can read.',
  ].join('\n');
}

export async function draftTurn(ctx: Ctx, ticket: Ticket, text: string): Promise<TicketDraftMessage> {
  ctx.store.addDraftMessage(ticket.id, 'stakeholder', text);
  const messages = ctx.store.draftMessages(ticket.id);
  const res = await invokeRole(ctx, {
    role: 'pm',
    model: ctx.project.config.meetingModel ?? undefined,
    prompt: draftPrompt(ticket, messages),
    cwd: ctx.project.root,
    contract: draftReplyContract,
    ticketId: ticket.id,
  });
  return ctx.store.addDraftMessage(ticket.id, 'pm', res.output.reply);
}
