import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSchema, MIGRATIONS } from '../src/db/schema';
import { Store } from '../src/db/store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-migration-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('agent_runs runner/model backfill', () => {
  it('backfills pre-tracking rows with cost and leaves zero-cost rows alone', () => {
    const path = join(dir, 'eng.db');
    new Store(path).close();

    const raw = new Database(path);
    const insert = raw.prepare(
      `INSERT INTO agent_runs (role, status, cost_usd, runner, model) VALUES (?, 'OK', ?, NULL, NULL)`,
    );
    insert.run('pm', 0.5);
    insert.run('developer', 0);
    raw.exec('ALTER TABLE tickets DROP COLUMN gate');
    raw.prepare(`DELETE FROM applied_migrations WHERE name IN ('backfill-pre-tracking-runs', 'ticket-gate')`).run();
    raw.exec('ALTER TABLE agent_runs DROP COLUMN cache_read_tokens');
    raw.exec('ALTER TABLE agent_runs DROP COLUMN cache_write_tokens');
    raw.prepare(`DELETE FROM applied_migrations WHERE name = 'agent-run-cache-tokens'`).run();
    raw.exec('ALTER TABLE tickets DROP COLUMN priority');
    raw.exec('ALTER TABLE tickets DROP COLUMN labels');
    raw.exec('DROP TABLE ticket_relations');
    raw.prepare(`DELETE FROM applied_migrations WHERE name = 'ticket-priority-labels-relations'`).run();
    raw.close();

    const store = new Store(path);
    const rows = store.agentRunsForTicket(-1);
    expect(rows).toEqual([]);
    const check = new Database(path, { readonly: true });
    const all = check
      .prepare(`SELECT role, runner, model FROM agent_runs ORDER BY id`)
      .all() as Array<{ role: string; runner: string | null; model: string | null }>;
    check.close();
    store.close();

    expect(all).toEqual([
      { role: 'pm', runner: 'claude-sdk', model: 'claude-opus-4-8' },
      { role: 'developer', runner: null, model: null },
    ]);
  });
});

describe('migration name ledger', () => {
  it('applies every migration once and records it by name', () => {
    const path = join(dir, 'ledger.db');
    new Store(path).close();
    const raw = new Database(path, { readonly: true });
    const names = raw.prepare(`SELECT name FROM applied_migrations ORDER BY name`).all().map((r: any) => r.name);
    raw.close();
    expect(names).toEqual([...MIGRATIONS.map((m) => m.name)].sort());
    const again = new Store(path);
    again.close();
  });

  it('seeds the ledger from legacy user_version counters without re-running', () => {
    const path = join(dir, 'legacy.db');
    new Store(path).close();
    const raw = new Database(path);
    raw.exec('DROP TABLE applied_migrations');
    raw.pragma(`user_version = ${MIGRATIONS.length}`);
    raw.close();
    const store = new Store(path);
    store.close();
    const check = new Database(path, { readonly: true });
    const n = (check.prepare(`SELECT COUNT(*) AS n FROM applied_migrations`).get() as any).n;
    check.close();
    expect(n).toBe(MIGRATIONS.length);
  });

  it('applies a missing migration by name regardless of position', () => {
    const path = join(dir, 'gap.db');
    new Store(path).close();
    const raw = new Database(path);
    raw.exec('ALTER TABLE tickets DROP COLUMN gate');
    raw.prepare(`DELETE FROM applied_migrations WHERE name = 'ticket-gate'`).run();
    raw.close();
    const store = new Store(path);
    store.close();
    const check = new Database(path, { readonly: true });
    const cols = check.prepare('PRAGMA table_info(tickets)').all().map((c: any) => c.name);
    check.close();
    expect(cols).toContain('gate');
  });
});

describe('duplicate-column self-heal', () => {
  it('absorbs a column that a divergent pre-ledger build already added', () => {
    const db = new Database(join(dir, 'heal.db'));
    createSchema(db);
    db.prepare(`DELETE FROM applied_migrations WHERE name = 'ticket-merged-sha'`).run();
    expect(() => createSchema(db)).not.toThrow();
    const names = (db.prepare(`SELECT name FROM applied_migrations`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('ticket-merged-sha');
    db.close();
  });
});
