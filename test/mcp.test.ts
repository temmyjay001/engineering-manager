import { describe, expect, it } from 'vitest';
import { resolveMcpServers } from '../src/agents/mcp';
import { parseEmConfig, type EmConfig } from '../src/project';

function configWith(raw: Record<string, unknown>): EmConfig {
  const parsed = parseEmConfig(raw);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.config;
}

describe('mcpServers config', () => {
  it('accepts stdio and remote server specs', () => {
    const config = configWith({
      mcpServers: {
        docs: { command: 'docs-mcp', args: ['--stdio'], env: { TOKEN: 'x' } },
        tracker: { type: 'http', url: 'https://tracker.local/mcp' },
        feed: { type: 'sse', url: 'https://feed.local/sse', headers: { authorization: 'Bearer t' } },
      },
    });
    expect(Object.keys(config.mcpServers)).toEqual(['docs', 'tracker', 'feed']);
  });

  it('rejects malformed specs and bad names', () => {
    expect('error' in parseEmConfig({ mcpServers: { docs: { args: [] } } })).toBe(true);
    expect('error' in parseEmConfig({ mcpServers: { docs: { command: 'x', urll: 'typo' } } })).toBe(true);
    expect('error' in parseEmConfig({ mcpServers: { 'bad name!': { command: 'x' } } })).toBe(true);
  });

  it('accepts per-role server lists', () => {
    const config = configWith({
      mcpServers: { docs: { command: 'docs-mcp' } },
      roles: { architect: { mcpServers: ['docs'] } },
    });
    expect(config.roles.architect?.mcpServers).toEqual(['docs']);
  });
});

describe('resolveMcpServers', () => {
  const config = configWith({
    mcpServers: {
      docs: { command: 'docs-mcp' },
      tracker: { type: 'http', url: 'https://tracker.local/mcp' },
    },
    roles: {
      architect: { mcpServers: ['docs', 'tracker'] },
      developer: {},
    },
  });

  it('returns the specs for the role in list order', () => {
    const resolved = resolveMcpServers(config, 'architect')!;
    expect(Object.keys(resolved)).toEqual(['docs', 'tracker']);
    expect(resolved.docs).toMatchObject({ command: 'docs-mcp' });
  });

  it('returns undefined when the role lists nothing', () => {
    expect(resolveMcpServers(config, 'developer')).toBeUndefined();
    expect(resolveMcpServers(config, 'uat')).toBeUndefined();
  });

  it('names the unknown server and the defined ones on error', () => {
    const broken = configWith({
      mcpServers: { docs: { command: 'docs-mcp' } },
      roles: { reviewer: { mcpServers: ['nope'] } },
    });
    expect(() => resolveMcpServers(broken, 'reviewer')).toThrow(/unknown MCP server "nope".*docs/);
  });

  it('errors helpfully when no servers are defined at all', () => {
    const empty = configWith({ roles: { pm: { mcpServers: ['docs'] } } });
    expect(() => resolveMcpServers(empty, 'pm')).toThrow(/No mcpServers are defined/);
  });
});
