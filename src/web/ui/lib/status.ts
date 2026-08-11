import type { EpicState, TicketState } from './types';

export interface Column {
  id: string;
  label: string;
  states: TicketState[];
  isVisible: (pipeline: string[]) => boolean;
}

function always(): boolean {
  return true;
}

function pipelineGates(pipeline: string[]): string[] {
  const dev = pipeline.indexOf('developer');
  return pipeline.slice(dev + 1);
}

function hasReviewGate(pipeline: string[]): boolean {
  return pipelineGates(pipeline).some((gate) => gate !== 'uat');
}

export const BOARD_COLUMNS: Column[] = [
  { id: 'backlog', label: 'Backlog', states: ['BACKLOG'], isVisible: always },
  { id: 'approval', label: 'Needs approval', states: ['AWAIT_APPROVAL'], isVisible: always },
  { id: 'design', label: 'Design', states: ['DESIGN'], isVisible: (pipeline) => pipeline.includes('architect') },
  { id: 'progress', label: 'In progress', states: ['READY', 'IN_PROGRESS'], isVisible: always },
  { id: 'review', label: 'In review', states: ['IN_REVIEW'], isVisible: hasReviewGate },
  { id: 'uat', label: 'UAT', states: ['UAT'], isVisible: (pipeline) => pipeline.includes('uat') },
  { id: 'landing', label: 'Landing', states: ['READY_TO_LAND', 'NEEDS_INTEGRATION'], isVisible: always },
  { id: 'done', label: 'Done', states: ['DONE', 'CLOSED'], isVisible: always },
  { id: 'blocked', label: 'Blocked', states: ['BLOCKED'], isVisible: always },
];

export function visibleColumns(pipeline: string[]): Column[] {
  return BOARD_COLUMNS.filter((column) => column.isVisible(pipeline));
}

export function boardColumns(pipeline: string[], showBacklog: boolean): Column[] {
  return visibleColumns(pipeline).filter((column) => column.id !== 'backlog' || showBacklog);
}

const STATE_LABEL: Record<TicketState, string> = {
  DRAFT: 'Draft',
  BACKLOG: 'Backlog',
  AWAIT_APPROVAL: 'Awaiting approval',
  DESIGN: 'Design',
  READY: 'Ready',
  IN_PROGRESS: 'In progress',
  IN_REVIEW: 'In review',
  UAT: 'UAT',
  READY_TO_LAND: 'Ready to land',
  NEEDS_INTEGRATION: 'Needs integration',
  DONE: 'Done',
  CLOSED: 'Closed',
  BLOCKED: 'Blocked',
};

export function stateLabel(state: TicketState): string {
  return STATE_LABEL[state] ?? state;
}

export type StatusTone = 'neutral' | 'active' | 'attention' | 'done' | 'error';

export function ticketTone(state: TicketState): StatusTone {
  if (state === 'DONE') return 'done';
  if (state === 'BLOCKED') return 'error';
  if (state === 'AWAIT_APPROVAL' || state === 'DRAFT' || state === 'NEEDS_INTEGRATION') return 'attention';
  if (state === 'BACKLOG' || state === 'CLOSED') return 'neutral';
  return 'active';
}

const EPIC_LABEL: Record<EpicState, string> = {
  PLANNING: 'Planning',
  AWAIT_PLAN: 'Awaiting plan',
  BUILDING: 'Building',
  DONE: 'Done',
  BLOCKED: 'Blocked',
};

export function epicStateLabel(state: EpicState): string {
  return EPIC_LABEL[state] ?? state;
}

export function epicTone(state: EpicState): StatusTone {
  if (state === 'DONE') return 'done';
  if (state === 'BLOCKED') return 'error';
  if (state === 'AWAIT_PLAN') return 'attention';
  if (state === 'BUILDING') return 'active';
  return 'neutral';
}

export function columnFor(state: TicketState): string {
  return BOARD_COLUMNS.find((c) => c.states.includes(state))?.id ?? 'backlog';
}

function pipelineGatesList(pipeline: string[]): string[] {
  const dev = pipeline.indexOf('developer');
  return pipeline.slice(dev + 1);
}

function gateStateFor(name: string): TicketState {
  return name === 'uat' ? 'UAT' : 'IN_REVIEW';
}

function currentGateName(gates: string[], ticket: { status: TicketState; gate: string | null }): string | null {
  if (ticket.gate && gates.includes(ticket.gate) && gateStateFor(ticket.gate) === ticket.status) return ticket.gate;
  return gates.find((g) => gateStateFor(g) === ticket.status) ?? null;
}

export const PRIORITY_LEVELS = ['low', 'medium', 'high', 'urgent'] as const;

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export function priorityRank(priority: string): number {
  return PRIORITY_RANK[priority] ?? PRIORITY_LEVELS.length;
}

export function priorityLabel(priority: string): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

export function priorityTone(priority: string): StatusTone {
  switch (priority) {
    case 'urgent':
      return 'error';
    case 'high':
      return 'attention';
    case 'medium':
      return 'active';
    default:
      return 'neutral';
  }
}

export function roleFor(pipeline: string[], ticket: { status: TicketState; gate: string | null }): string | null {
  switch (ticket.status) {
    case 'BACKLOG':
      return 'pm';
    case 'DESIGN':
      return pipeline.includes('architect') ? 'architect' : null;
    case 'READY':
    case 'IN_PROGRESS':
      return 'developer';
    case 'IN_REVIEW':
    case 'UAT':
      return currentGateName(pipelineGatesList(pipeline), ticket);
    case 'DRAFT':
      return null;
    case 'READY_TO_LAND':
    case 'NEEDS_INTEGRATION':
      return 'integration';
    case 'AWAIT_APPROVAL':
    case 'DONE':
    case 'CLOSED':
    case 'BLOCKED':
      return null;
  }
}
