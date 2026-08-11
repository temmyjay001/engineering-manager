import type { EmConfig, McpServerSpec } from '../project';

export function resolveMcpServers(config: EmConfig, role: string): Record<string, McpServerSpec> | undefined {
  const names = config.roles[role]?.mcpServers ?? [];
  if (names.length === 0) return undefined;
  const resolved: Record<string, McpServerSpec> = {};
  for (const name of names) {
    const spec = config.mcpServers[name];
    if (!spec) {
      const available = Object.keys(config.mcpServers);
      throw new Error(
        `Role "${role}" references unknown MCP server "${name}". ` +
          (available.length ? `Defined servers: ${available.join(', ')}.` : 'No mcpServers are defined in .em/config.json.'),
      );
    }
    resolved[name] = spec;
  }
  return resolved;
}
