import { runPmDraft, type PmDraftMessage } from './agents/roles/pm';
import type { Ctx } from './ctx';
import type { Ticket, TicketDraftMessage } from './domain/types';

function conversation(messages: TicketDraftMessage[]): PmDraftMessage[] {
  return messages.map((m) => ({ speaker: m.sender, text: m.text }));
}

async function draftTurn(ctx: Ctx, ticket: Ticket): Promise<TicketDraftMessage> {
  const { store } = ctx;
  const messages = store.draftMessages(ticket.id);
  const out = await runPmDraft(ctx, ticket.description, [], conversation(messages));
  store.setTitle(ticket.id, out.title);
  store.setCriteria(
    ticket.id,
    out.acceptanceCriteria.map((text) => ({ text, isUi: false })),
  );
  store.setPriority(ticket.id, out.priority);
  store.setLabels(ticket.id, out.labels);
  return store.addDraftMessage(ticket.id, 'pm', out.reply);
}

export async function startDraft(ctx: Ctx, ticket: Ticket): Promise<TicketDraftMessage> {
  return draftTurn(ctx, ticket);
}

export async function sayToDraft(ctx: Ctx, ticket: Ticket, text: string): Promise<TicketDraftMessage> {
  ctx.store.addDraftMessage(ticket.id, 'stakeholder', text);
  return draftTurn(ctx, ticket);
}
