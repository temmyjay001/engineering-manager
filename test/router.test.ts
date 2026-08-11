import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../src/domain/types';
import { Store } from '../src/db/store';
import { parseEmConfig, type Project } from '../src/project';
import { registerApiRoutes } from '../src/web/api';
import { createRouter, type ApiContext } from '../src/web/router';

vi.mock('../src/drafting', () => ({
  startDraft: vi.fn(async (ctx: ApiContext, ticket: Ticket) =>
    ctx.store.addDraftMessage(ticket.id, 'pm', `What does "${ticket.description}" need to cover?`),
  ),
  sayToDraft: vi.fn(async (ctx: ApiContext, ticket: Ticket, text: string) => {
    ctx.store.addDraftMessage(ticket.id, 'stakeholder', text);
    return ctx.store.addDraftMessage(ticket.id, 'pm', `Got it: ${text}`);
  }),
}));

const req = {} as IncomingMessage;
const res = {} as ServerResponse;
const ctx = {} as ApiContext;

describe('router', () => {
  it('matches static routes by method and path', async () => {
    const router = createRouter();
    let hits = 0;
    router.register('GET', '/board', () => {
      hits += 1;
    });
    expect(await router.handle('GET', '/board', req, res, ctx)).toBe(true);
    expect(await router.handle('get', '/board', req, res, ctx)).toBe(true);
    expect(await router.handle('POST', '/board', req, res, ctx)).toBe(false);
    expect(await router.handle('GET', '/nope', req, res, ctx)).toBe(false);
    expect(hits).toBe(2);
  });

  it('extracts and decodes params', async () => {
    const router = createRouter();
    let seen: Record<string, string> = {};
    router.register('POST', '/tickets/:key/run', (_req, _res, _ctx, params) => {
      seen = params;
    });
    expect(await router.handle('POST', '/tickets/EM-1/run', req, res, ctx)).toBe(true);
    expect(seen.key).toBe('EM-1');
    await router.handle('POST', '/tickets/EM%2D9/run', req, res, ctx);
    expect(seen.key).toBe('EM-9');
  });

  it('does not match routes of different segment length', async () => {
    const router = createRouter();
    router.register('GET', '/epics/:key', () => {});
    expect(await router.handle('GET', '/epics', req, res, ctx)).toBe(false);
    expect(await router.handle('GET', '/epics/EP-1/extra', req, res, ctx)).toBe(false);
  });
});

function fakeRequest(body?: unknown): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return Readable.from([Buffer.from(payload)]) as unknown as IncomingMessage;
}

function fakeResponse(): { res: ServerResponse; status: () => number; json: () => any } {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') raw = chunk;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, json: () => JSON.parse(raw) };
}

describe('ticket priority, labels, and relations API', () => {
  let dir: string;
  let store: Store;
  let apiCtx: ApiContext;
  let router: ReturnType<typeof createRouter>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-router-'));
    store = new Store(join(dir, 'eng.db'));
    const parsed = parseEmConfig({});
    if ('error' in parsed) throw new Error(parsed.error);
    const project: Project = {
      root: dir,
      emDir: join(dir, '.em'),
      dbPath: join(dir, 'eng.db'),
      worktreesDir: join(dir, '.em', 'worktrees'),
      scratchDir: join(dir, '.em', 'scratch'),
      configPath: join(dir, '.em', 'config.json'),
      config: parsed.config,
    };
    apiCtx = { store, project };
    router = createRouter();
    registerApiRoutes(router);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('updates priority and reflects it in ticket details', async () => {
    const ticket = store.createTicket({ title: '', description: 'x' });
    const { res, status, json } = fakeResponse();
    await router.handle('PUT', `/tickets/${ticket.key}/priority`, fakeRequest({ priority: 'high' }), res, apiCtx);
    expect(status()).toBe(200);
    expect(json().priority).toBe('high');
    expect(store.getTicketById(ticket.id)?.priority).toBe('high');
  });

  it('returns 404 when updating priority for an unknown ticket', async () => {
    const { res, status, json } = fakeResponse();
    await router.handle('PUT', '/tickets/EM-999/priority', fakeRequest({ priority: 'high' }), res, apiCtx);
    expect(status()).toBe(404);
    expect(json().error).toBeTruthy();
  });

  it('returns 400 when priority is missing', async () => {
    const ticket = store.createTicket({ title: '', description: 'x' });
    const { res, status, json } = fakeResponse();
    await router.handle('PUT', `/tickets/${ticket.key}/priority`, fakeRequest({}), res, apiCtx);
    expect(status()).toBe(400);
    expect(json().error).toBeTruthy();
  });

  it('replaces labels, normalizing case and whitespace', async () => {
    const ticket = store.createTicket({ title: '', description: 'x' });
    const { res, status, json } = fakeResponse();
    await router.handle(
      'PUT',
      `/tickets/${ticket.key}/labels`,
      fakeRequest({ labels: ['  Backend  ', 'URGENT'] }),
      res,
      apiCtx,
    );
    expect(status()).toBe(200);
    expect(json().labels).toEqual(['backend', 'urgent']);
    expect(store.getTicketById(ticket.id)?.labels).toEqual(['backend', 'urgent']);
  });

  it('rejects a label exceeding 24 characters and stores none of the submitted labels', async () => {
    const ticket = store.createTicket({ title: '', description: 'x' });
    const { res, status, json } = fakeResponse();
    await router.handle(
      'PUT',
      `/tickets/${ticket.key}/labels`,
      fakeRequest({ labels: ['ok', 'this-label-is-definitely-way-too-long'] }),
      res,
      apiCtx,
    );
    expect(status()).toBe(400);
    expect(json().error).toBeTruthy();
    expect(store.getTicketById(ticket.id)?.labels).toEqual([]);
  });

  it('returns 404 when updating labels for an unknown ticket', async () => {
    const { res, status, json } = fakeResponse();
    await router.handle('PUT', '/tickets/EM-999/labels', fakeRequest({ labels: ['x'] }), res, apiCtx);
    expect(status()).toBe(404);
    expect(json().error).toBeTruthy();
  });

  it('adds a blocks relation between tickets in different epics', async () => {
    const epicA = store.createEpic({ title: 'a', description: 'a' });
    const epicB = store.createEpic({ title: 'b', description: 'b' });
    const a = store.createTicket({ title: '', description: 'a', epicId: epicA.id, seq: 1 });
    const b = store.createTicket({ title: '', description: 'b', epicId: epicB.id, seq: 1 });
    const { res, status, json } = fakeResponse();
    await router.handle(
      'POST',
      `/tickets/${a.key}/relations`,
      fakeRequest({ type: 'blocks', targetKey: b.key }),
      res,
      apiCtx,
    );
    expect(status()).toBe(201);
    expect(json().relationType).toBe('blocks');
    expect(store.getTicketRelations(a.id)).toHaveLength(1);
  });

  it('adds a relates-to relation between tickets', async () => {
    const a = store.createTicket({ title: '', description: 'a' });
    const b = store.createTicket({ title: '', description: 'b' });
    const { res, status, json } = fakeResponse();
    await router.handle(
      'POST',
      `/tickets/${a.key}/relations`,
      fakeRequest({ type: 'relates-to', targetKey: b.key }),
      res,
      apiCtx,
    );
    expect(status()).toBe(201);
    expect(json().relationType).toBe('relates-to');
  });

  it('rejects a relation type other than blocks or relates-to', async () => {
    const a = store.createTicket({ title: '', description: 'a' });
    const b = store.createTicket({ title: '', description: 'b' });
    const { res, status, json } = fakeResponse();
    await router.handle(
      'POST',
      `/tickets/${a.key}/relations`,
      fakeRequest({ type: 'duplicates', targetKey: b.key }),
      res,
      apiCtx,
    );
    expect(status()).toBe(400);
    expect(json().error).toBeTruthy();
    expect(store.getTicketRelations(a.id)).toHaveLength(0);
  });

  it('rejects a relation pointing to an unknown ticket', async () => {
    const a = store.createTicket({ title: '', description: 'a' });
    const { res, status, json } = fakeResponse();
    await router.handle(
      'POST',
      `/tickets/${a.key}/relations`,
      fakeRequest({ type: 'blocks', targetKey: 'EM-999' }),
      res,
      apiCtx,
    );
    expect(status()).toBe(400);
    expect(json().error).toBeTruthy();
  });

  it('deletes a relation so it no longer appears among the ticket relations', async () => {
    const a = store.createTicket({ title: '', description: 'a' });
    const b = store.createTicket({ title: '', description: 'b' });
    const relation = store.addTicketRelation(a.id, b.id, 'blocks');
    const { res, status, json } = fakeResponse();
    await router.handle('DELETE', `/tickets/${a.key}/relations/${relation.id}`, fakeRequest(), res, apiCtx);
    expect(status()).toBe(200);
    expect(json().relations).toEqual([]);

    const getRes = fakeResponse();
    await router.handle('GET', `/tickets/${a.key}`, fakeRequest(), getRes.res, apiCtx);
    expect(getRes.json().relations).toEqual([]);
  });

  it('returns an error and leaves relations unchanged when deleting a relation that does not exist', async () => {
    const a = store.createTicket({ title: '', description: 'a' });
    const b = store.createTicket({ title: '', description: 'b' });
    const relation = store.addTicketRelation(a.id, b.id, 'blocks');
    const { res, status, json } = fakeResponse();
    await router.handle('DELETE', `/tickets/${a.key}/relations/999999`, fakeRequest(), res, apiCtx);
    expect(status()).toBe(404);
    expect(json().error).toBeTruthy();
    expect(store.getTicketRelations(a.id)).toEqual([relation]);
  });

  it('lists distinct, normalized labels used across the project', async () => {
    const a = store.createTicket({ title: '', description: 'a' });
    const b = store.createTicket({ title: '', description: 'b' });
    store.setLabels(a.id, ['backend', 'urgent']);
    store.setLabels(b.id, ['urgent', 'frontend']);
    const { res, status, json } = fakeResponse();
    await router.handle('GET', '/labels', fakeRequest(), res, apiCtx);
    expect(status()).toBe(200);
    expect(json().labels.sort()).toEqual(['backend', 'frontend', 'urgent']);
  });
});

describe('conversational draft-ticket API', () => {
  let dir: string;
  let store: Store;
  let apiCtx: ApiContext;
  let router: ReturnType<typeof createRouter>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-router-draft-'));
    store = new Store(join(dir, 'eng.db'));
    const parsed = parseEmConfig({});
    if ('error' in parsed) throw new Error(parsed.error);
    const project: Project = {
      root: dir,
      emDir: join(dir, '.em'),
      dbPath: join(dir, 'eng.db'),
      worktreesDir: join(dir, '.em', 'worktrees'),
      scratchDir: join(dir, '.em', 'scratch'),
      configPath: join(dir, '.em', 'config.json'),
      config: parsed.config,
    };
    apiCtx = { store, project };
    router = createRouter();
    registerApiRoutes(router);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a DRAFT ticket and returns its key with 201', async () => {
    const { res, status, json } = fakeResponse();
    await router.handle('POST', '/tickets/draft', fakeRequest({ description: 'let people export CSV reports' }), res, apiCtx);
    expect(status()).toBe(201);
    expect(json().key).toBeTruthy();
    const ticket = store.getTicketByKey(json().key);
    expect(ticket?.status).toBe('DRAFT');
  });

  it('rejects an empty or missing description and creates no ticket', async () => {
    const before = store.listTickets().length;
    const { res, status, json } = fakeResponse();
    await router.handle('POST', '/tickets/draft', fakeRequest({ description: '   ' }), res, apiCtx);
    expect(status()).toBe(400);
    expect(json().error).toBeTruthy();

    const { res: res2, status: status2 } = fakeResponse();
    await router.handle('POST', '/tickets/draft', fakeRequest({}), res2, apiCtx);
    expect(status2()).toBe(400);
    expect(store.listTickets().length).toBe(before);
  });

  it('already has a PM message in the draft conversation immediately after creation', async () => {
    const { res, status, json } = fakeResponse();
    await router.handle('POST', '/tickets/draft', fakeRequest({ description: 'add dark mode' }), res, apiCtx);
    expect(status()).toBe(201);
    const ticket = store.getTicketByKey(json().key)!;
    const messages = store.draftMessages(ticket.id);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]!.sender).toBe('pm');
    expect(messages[0]!.text).toBeTruthy();
  });

  it('lists every exchanged draft message in order, tagged with sender and text', async () => {
    const createRes = fakeResponse();
    await router.handle('POST', '/tickets/draft', fakeRequest({ description: 'add dark mode' }), createRes.res, apiCtx);
    const ticket = store.getTicketByKey(createRes.json().key)!;

    const sayRes = fakeResponse();
    await router.handle('POST', `/tickets/${ticket.key}/draft/say`, fakeRequest({ text: 'only for the settings page' }), sayRes.res, apiCtx);
    expect(sayRes.status()).toBe(200);

    const { res, status, json } = fakeResponse();
    await router.handle('GET', `/tickets/${ticket.key}/draft/messages`, fakeRequest(), res, apiCtx);
    expect(status()).toBe(200);
    const messages = json().messages;
    expect(messages).toHaveLength(3);
    expect(messages.map((m: { sender: string }) => m.sender)).toEqual(['pm', 'stakeholder', 'pm']);
    expect(messages[1].text).toBe('only for the settings page');
  });

  it('returns 404 for the draft conversation of an unknown ticket', async () => {
    const { res, status, json } = fakeResponse();
    await router.handle('GET', '/tickets/EM-999/draft/messages', fakeRequest(), res, apiCtx);
    expect(status()).toBe(404);
    expect(json().error).toBeTruthy();
  });

  it('adds a stakeholder message and appends the agent reply after it', async () => {
    const createRes = fakeResponse();
    await router.handle('POST', '/tickets/draft', fakeRequest({ description: 'add dark mode' }), createRes.res, apiCtx);
    const ticket = store.getTicketByKey(createRes.json().key)!;
    const before = store.draftMessages(ticket.id);

    const { res, status, json } = fakeResponse();
    await router.handle('POST', `/tickets/${ticket.key}/draft/say`, fakeRequest({ text: 'just the settings page' }), res, apiCtx);
    expect(status()).toBe(200);
    expect(json().reply.text).toBeTruthy();

    const after = store.draftMessages(ticket.id);
    expect(after).toHaveLength(before.length + 2);
    expect(after[before.length]!.sender).toBe('stakeholder');
    expect(after[before.length]!.text).toBe('just the settings page');
    expect(after[before.length + 1]!.sender).toBe('pm');
  });

  it('rejects an empty or missing stakeholder message and leaves the conversation unchanged', async () => {
    const createRes = fakeResponse();
    await router.handle('POST', '/tickets/draft', fakeRequest({ description: 'add dark mode' }), createRes.res, apiCtx);
    const ticket = store.getTicketByKey(createRes.json().key)!;
    const before = store.draftMessages(ticket.id);

    const { res, status, json } = fakeResponse();
    await router.handle('POST', `/tickets/${ticket.key}/draft/say`, fakeRequest({ text: '   ' }), res, apiCtx);
    expect(status()).toBe(400);
    expect(json().error).toBeTruthy();
    expect(store.draftMessages(ticket.id)).toEqual(before);
  });

  it('rejects a stakeholder message to a ticket that is not in DRAFT status', async () => {
    const ticket = store.createTicket({ title: 't', description: 'x' });
    const { res, status, json } = fakeResponse();
    await router.handle('POST', `/tickets/${ticket.key}/draft/say`, fakeRequest({ text: 'hello' }), res, apiCtx);
    expect(status()).toBe(409);
    expect(json().error).toBeTruthy();
    expect(store.draftMessages(ticket.id)).toEqual([]);
  });

  it('returns 404 when messaging a draft for an unknown ticket', async () => {
    const { res, status, json } = fakeResponse();
    await router.handle('POST', '/tickets/EM-999/draft/say', fakeRequest({ text: 'hello' }), res, apiCtx);
    expect(status()).toBe(404);
    expect(json().error).toBeTruthy();
  });

  it('accepts a draft, saving the submitted title, description, criteria, and UI details, and moves it to AWAIT_APPROVAL', async () => {
    const ticket = store.createDraftTicket({ description: 'add CSV export' });
    store.setCriteria(ticket.id, [{ text: 'stale criterion from the conversation', isUi: false }]);

    const { res, status, json } = fakeResponse();
    await router.handle(
      'POST',
      `/tickets/${ticket.key}/draft/accept`,
      fakeRequest({
        title: 'Add CSV export button',
        description: 'Let users export their reports as CSV',
        criteria: [
          { text: 'a CSV export button appears on the reports page', isUi: true },
          { text: 'clicking it downloads a well-formed CSV file', isUi: false },
        ],
        hasUi: true,
        runCommand: 'npm run dev',
        appUrl: 'http://localhost:3000',
      }),
      res,
      apiCtx,
    );
    expect(status()).toBe(200);
    expect(json().status).toBe('AWAIT_APPROVAL');

    const saved = store.getTicketById(ticket.id)!;
    expect(saved.title).toBe('Add CSV export button');
    expect(saved.description).toBe('Let users export their reports as CSV');
    expect(saved.status).toBe('AWAIT_APPROVAL');
    expect(saved.hasUi).toBe(true);
    expect(saved.runCommand).toBe('npm run dev');
    expect(saved.appUrl).toBe('http://localhost:3000');

    const criteria = store.getCriteria(ticket.id);
    expect(criteria.map((c) => ({ text: c.text, isUi: c.isUi }))).toEqual([
      { text: 'a CSV export button appears on the reports page', isUi: true },
      { text: 'clicking it downloads a well-formed CSV file', isUi: false },
    ]);

    const reread = fakeResponse();
    await router.handle('GET', `/tickets/${ticket.key}`, fakeRequest(), reread.res, apiCtx);
    expect(reread.json().status).toBe('AWAIT_APPROVAL');
  });

  it('rejects accepting a draft with no acceptance criteria and leaves its status unchanged', async () => {
    const ticket = store.createDraftTicket({ description: 'add CSV export' });
    const { res, status, json } = fakeResponse();
    await router.handle(
      'POST',
      `/tickets/${ticket.key}/draft/accept`,
      fakeRequest({ title: 't', description: 'd', criteria: [], hasUi: false, runCommand: null, appUrl: null }),
      res,
      apiCtx,
    );
    expect(status()).toBe(400);
    expect(json().error).toBeTruthy();
    expect(store.getTicketById(ticket.id)?.status).toBe('DRAFT');
  });

  it('rejects accepting a ticket that is not in DRAFT status', async () => {
    const ticket = store.createTicket({ title: 't', description: 'x' });
    const { res, status, json } = fakeResponse();
    await router.handle(
      'POST',
      `/tickets/${ticket.key}/draft/accept`,
      fakeRequest({ title: 't', description: 'd', criteria: [{ text: 'a thing happens', isUi: false }] }),
      res,
      apiCtx,
    );
    expect(status()).toBe(409);
    expect(json().error).toBeTruthy();
    const unchanged = store.getTicketById(ticket.id)!;
    expect(unchanged.status).toBe('BACKLOG');
    expect(unchanged.title).toBe('t');
  });

  it('returns 404 when accepting an unknown draft ticket', async () => {
    const { res, status, json } = fakeResponse();
    await router.handle(
      'POST',
      '/tickets/EM-999/draft/accept',
      fakeRequest({ title: 't', description: 'd', criteria: [{ text: 'a thing happens', isUi: false }] }),
      res,
      apiCtx,
    );
    expect(status()).toBe(404);
    expect(json().error).toBeTruthy();
  });
});
