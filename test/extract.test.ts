import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ticketBlock } from '../src/agents/context';
import { Store } from '../src/db/store';
import { contractInstructions, extractJson } from '../src/agents/extract';

describe('extractJson', () => {
  it('extracts a fenced json block', () => {
    expect(extractJson('report text\n```json\n{"ok": true}\n```')).toEqual({ ok: true });
  });

  it('prefers the last fenced block', () => {
    const text = '```json\n{"n": 1}\n```\nmore\n```json\n{"n": 2}\n```';
    expect(extractJson(text)).toEqual({ n: 2 });
  });

  it('accepts unfenced trailing objects', () => {
    expect(extractJson('done. {"verdict": "PASS", "nested": {"a": 1}}')).toEqual({
      verdict: 'PASS',
      nested: { a: 1 },
    });
  });

  it('tolerates trailing commas and comments', () => {
    const text = '```json\n{\n // a comment\n "items": [1, 2,],\n}\n```';
    expect(extractJson(text)).toEqual({ items: [1, 2] });
  });

  it('skips broken candidates and falls back to earlier ones', () => {
    const text = '```json\n{"good": true}\n```\n```json\nnot json at all\n```';
    expect(extractJson(text)).toEqual({ good: true });
  });

  it('throws when no JSON is present', () => {
    expect(() => extractJson('no structured data here')).toThrow(/No parseable JSON/);
  });
});

describe('contractInstructions', () => {
  it('embeds the schema and escalates on retry', () => {
    const schema = { type: 'object' };
    const first = contractInstructions(schema);
    const second = contractInstructions(schema, true);
    expect(first).toContain('"type":"object"');
    expect(first).not.toContain('IMPORTANT');
    expect(second).toContain('IMPORTANT');
  });
});

describe('ticketBlock', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-ticketblock-'));
    store = new Store(join(dir, 'eng.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes the ticket priority and labels', () => {
    const ticket = store.createTicket({ title: 'Do the thing', description: 'x' });
    store.setPriority(ticket.id, 'high');
    store.setLabels(ticket.id, ['backend', 'urgent']);
    const updated = store.getTicketById(ticket.id)!;

    const block = ticketBlock(updated);
    expect(block).toContain('Priority: high');
    expect(block).toContain('Labels: backend, urgent');
  });

  it('states there are no labels when the ticket has none', () => {
    const ticket = store.createTicket({ title: 'Do the thing', description: 'x' });
    const block = ticketBlock(ticket);
    expect(block).toContain('Labels: none');
    expect(block).not.toMatch(/Labels:\s*$/m);
  });

  it('leaves the stored priority and labels untouched after building the block', () => {
    const ticket = store.createTicket({ title: 'Do the thing', description: 'x' });
    store.setPriority(ticket.id, 'low');
    store.setLabels(ticket.id, ['docs']);
    const before = store.getTicketById(ticket.id)!;

    ticketBlock(before);

    const after = store.getTicketById(ticket.id)!;
    expect(after.priority).toBe(before.priority);
    expect(after.labels).toEqual(before.labels);
  });
});
