export const ROLES = ['planner', 'pm', 'architect', 'developer', 'reviewer', 'uat'] as const;
export type Role = (typeof ROLES)[number];
export type PipelineRole = Exclude<Role, 'planner'>;

export const DEFAULT_MODEL = 'claude-opus-4-8';
export const CUSTOM_GATE_MAX_TURNS = 30;
export const MEETING_MAX_TURNS = 60;
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;

export const ROLE_MODELS: Record<Role, string> = {
  planner: DEFAULT_MODEL,
  pm: DEFAULT_MODEL,
  architect: DEFAULT_MODEL,
  developer: DEFAULT_MODEL,
  reviewer: DEFAULT_MODEL,
  uat: DEFAULT_MODEL,
};

export const ROLE_MAX_TURNS: Record<Role, number> = {
  planner: 40,
  pm: 25,
  architect: 30,
  developer: 100,
  reviewer: 40,
  uat: 150,
};

export const ROLE_TOOLS: Record<Role, string[]> = {
  planner: ['Read', 'Grep', 'Glob'],
  pm: ['Read', 'Grep', 'Glob'],
  architect: ['Read', 'Grep', 'Glob'],
  developer: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
  reviewer: ['Read', 'Grep', 'Glob'],
  uat: ['Read', 'Grep', 'Glob', 'Bash'],
};

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

export const PLAYWRIGHT_TOOLS = [
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_navigate_back',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_take_screenshot',
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_fill_form',
  'mcp__playwright__browser_select_option',
  'mcp__playwright__browser_hover',
  'mcp__playwright__browser_press_key',
  'mcp__playwright__browser_wait_for',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_close',
];

export const PLAYWRIGHT_MCP = {
  type: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest'],
};
