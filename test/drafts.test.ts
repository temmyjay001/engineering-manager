import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/store';
import { draftTranscript } from '../src/drafts';

describe('draftTranscript', () => {
  it('labels each side and marks an empty conversation', () => {
    expect(draftTranscript([])).toContain('just started');
  });
});

describe('draft conversation store round-trip', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-draft-'));
    store = new Store(join(dir, 'eng.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resumes a draft where the stakeholder left off', () => {
    const t = store.createTicket({ title: '', description: 'a login page' });
    store.transition({ ticketId: t.id, from: 'BACKLOG', to: 'DRAFT', role: null, verdict: null, note: null });
    store.addDraftMessage(t.id, 'stakeholder', 'I want SSO too');
    store.addDraftMessage(t.id, 'pm', 'which provider?');

    const messages = store.draftMessages(t.id);
    expect(draftTranscript(messages)).toBe('[stakeholder] I want SSO too\n\n[pm] which provider?');
  });
});
