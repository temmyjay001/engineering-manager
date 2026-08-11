import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx';
import { Store } from '../src/db/store';
import { EmMcpServer } from '../src/mcp/server';
import { parseEmConfig, type Project } from '../src/project';

let dir: string;
let store: Store;
let server: EmMcpServer;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-mcp-'));
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
  const ctx: Ctx = { store, project };
  server = new EmMcpServer(ctx);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

describe('EmMcpServer', () => {
  it('initializes with tool capability and server info', async () => {
    const res: any = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.result.serverInfo.name).toBe('emorg');
    expect(res.result.capabilities.tools).toEqual({});
  });

  it('ignores notifications and rejects unknown methods', async () => {
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const res: any = await server.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    expect(res.error.code).toBe(-32601);
  });

  it('lists tools with schemas', async () => {
    const res: any = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain('create_ticket');
    expect(names).toContain('run_ticket');
    expect(names).toContain('report');
    for (const tool of res.result.tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('creates tickets and reads them back through status and show_ticket', async () => {
    const created: any = await call('create_ticket', { description: 'Add dark mode' });
    expect(created.result.content[0].text).toContain('Created EM-1');

    const status: any = await call('status');
    const parsed = JSON.parse(status.result.content[0].text);
    expect(parsed.tickets).toHaveLength(1);
    expect(parsed.tickets[0].key).toBe('EM-1');

    const shown: any = await call('show_ticket', { key: 'EM-1' });
    expect(JSON.parse(shown.result.content[0].text)).toMatchObject({ key: 'EM-1', status: 'BACKLOG' });
  });

  it('returns tool errors as isError results, not protocol errors', async () => {
    const missing: any = await call('show_ticket', { key: 'EM-999' });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toContain('no ticket');

    const badApprove: any = await call('approve_ticket', { key: 'EM-999' });
    expect(badApprove.result.isError).toBe(true);

    const noDescription: any = await call('create_ticket', {});
    expect(noDescription.result.isError).toBe(true);
  });

  it('serves the report with advice attached', async () => {
    const res: any = await call('report', { days: 0 });
    const report = JSON.parse(res.result.content[0].text);
    expect(report.windowDays).toBeNull();
    expect(Array.isArray(report.advice)).toBe(true);
  });
});
