import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/store';
import type { Meeting, Ticket } from '../src/domain/types';
import {
  agentParticipants,
  boardSnapshot,
  composeMinutes,
  draftOpeningMessage,
  invitableRoles,
  pickResponder,
  transcriptBlock,
  validateParticipants,
} from '../src/meetings';

const PIPELINE = ['pm', 'architect', 'developer', 'reviewer', 'security', 'uat'];

function meeting(participants: string[]): Meeting {
  return {
    id: 1,
    title: 't',
    participants,
    ticketId: null,
    epicId: null,
    status: 'OPEN',
    summary: null,
    createdAt: '',
    updatedAt: '',
  };
}

describe('participants', () => {
  it('lists invitable roles: meeting trio, reviewer, and custom gates', () => {
    expect(invitableRoles(PIPELINE).sort()).toEqual(['architect', 'planner', 'pm', 'reviewer', 'security']);
  });

  it('rejects write-capable and unknown roles, and empty invites', () => {
    expect(validateParticipants(['you'], PIPELINE)).toMatch(/at least one agent/);
    expect(validateParticipants(['you', 'developer'], PIPELINE)).toMatch(/developer cannot attend/);
    expect(validateParticipants(['you', 'ghost'], PIPELINE)).toMatch(/unknown participants: ghost/);
    expect(validateParticipants(['you', 'pm', 'architect', 'security'], PIPELINE)).toBeNull();
  });
});

describe('pickResponder', () => {
  const m = meeting(['you', 'pm', 'architect']);

  it('uses explicit addressing first, then @mentions, then the first agent', () => {
    expect(pickResponder(m, 'thoughts?', 'architect')).toBe('architect');
    expect(pickResponder(m, '@architect can we reuse the auth middleware?')).toBe('architect');
    expect(pickResponder(m, 'what should the criteria be?')).toBe('pm');
  });

  it('rejects addressing someone not in the room', () => {
    expect(() => pickResponder(m, 'hi', 'planner')).toThrow(/not in this meeting/);
    expect(agentParticipants(m)).toEqual(['pm', 'architect']);
  });
});

describe('transcript and store CRUD', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-meeting-'));
    store = new Store(join(dir, 'eng.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips meetings and messages, and ends with a summary', () => {
    const t = store.createTicket({ title: 'x', description: 'y' });
    const m = store.createMeeting({ title: 'Kickoff', participants: ['you', 'pm'], ticketId: t.id });
    expect(m.status).toBe('OPEN');
    expect(m.ticketId).toBe(t.id);

    store.addMeetingMessage(m.id, 'you', 'hello');
    store.addMeetingMessage(m.id, 'pm', 'hi, what problem are we solving?');
    const messages = store.meetingMessages(m.id);
    expect(messages.map((x) => x.speaker)).toEqual(['you', 'pm']);

    expect(transcriptBlock(messages)).toBe('[stakeholder] hello\n\n[pm] hi, what problem are we solving?');
    expect(transcriptBlock([])).toContain('just started');

    store.endMeeting(m.id, 'agreed on scope');
    const ended = store.getMeeting(m.id)!;
    expect(ended.status).toBe('ENDED');
    expect(ended.summary).toBe('agreed on scope');
    expect(store.listMeetings()[0]!.id).toBe(m.id);
  });
});

describe('boardSnapshot', () => {
  it('describes an empty board', () => {
    expect(boardSnapshot([])).toContain('no tickets yet');
  });

  it('lists key, status, and title for each ticket', () => {
    const tickets = [{ key: 'EM-1', status: 'DONE', title: 'Add rate limiting' } as Ticket];
    expect(boardSnapshot(tickets)).toBe('EM-1 [DONE] Add rate limiting');
  });

  it('falls back to (untitled) for a ticket with no title', () => {
    const tickets = [{ key: 'EM-2', status: 'DRAFT', title: '' } as Ticket];
    expect(boardSnapshot(tickets)).toBe('EM-2 [DRAFT] (untitled)');
  });
});

describe('draftOpeningMessage', () => {
  it('names the action item and the originating meeting', () => {
    const msg = draftOpeningMessage({ title: 'Add SSO', description: 'Support SAML login' }, 'Q3 Planning');
    expect(msg).toContain('Add SSO');
    expect(msg).toContain('Support SAML login');
    expect(msg).toContain('Q3 Planning');
  });
});

describe('composeMinutes', () => {
  it('lists the key of every created draft ticket', () => {
    const created = [{ key: 'EM-10' } as Ticket, { key: 'EM-11' } as Ticket];
    const text = composeMinutes('Agreed to ship the export feature.', created, []);
    expect(text).toContain('EM-10');
    expect(text).toContain('EM-11');
  });

  it('states which action items were skipped and why', () => {
    const text = composeMinutes('Nothing new agreed.', [], [
      'Skipped "Add dark mode" as already delivered (EM-9).',
    ]);
    expect(text).toContain('Skipped "Add dark mode"');
    expect(text).toContain('already delivered');
  });

  it('omits the created-drafts line when nothing was created', () => {
    expect(composeMinutes('summary', [], [])).toBe('summary');
  });
});
