import type { TicketState } from './types';

export const BUILTIN_STAGES = ['pm', 'architect', 'developer', 'reviewer', 'uat'] as const;
export const DEFAULT_PIPELINE: string[] = [...BUILTIN_STAGES];

const RESERVED_STAGE_NAMES = new Set(['planner', 'approval', 'human']);

export interface ResolvedAgentStage {
  kind: 'agent';
  role: string;
  onPass: TicketState;
  onPassGate: string | null;
  onFail: TicketState;
}

export interface ResolvedHumanStage {
  kind: 'human';
  onApprove: TicketState;
  onReject: TicketState;
}

export interface ResolvedSkipStage {
  kind: 'skip';
  to: TicketState;
  gate: string | null;
  note: string;
}

export interface ResolvedLandStage {
  kind: 'land';
}

export type ResolvedStage = ResolvedAgentStage | ResolvedHumanStage | ResolvedSkipStage | ResolvedLandStage | null;

export function validatePipeline(pipeline: string[]): string | null {
  if (new Set(pipeline).size !== pipeline.length) return 'pipeline stages must be unique';
  if (pipeline[0] !== 'pm') return 'pipeline must start with pm';
  const dev = pipeline.indexOf('developer');
  if (dev === -1) return 'pipeline must include developer';
  const architect = pipeline.indexOf('architect');
  if (architect !== -1 && architect > dev) return 'architect must come before developer';
  for (const [index, name] of pipeline.entries()) {
    if (RESERVED_STAGE_NAMES.has(name)) return `"${name}" is a reserved stage name`;
    const builtin = (BUILTIN_STAGES as readonly string[]).includes(name);
    if (!builtin && index < dev) return `custom gate "${name}" must come after developer`;
  }
  return null;
}

export function pipelineGates(pipeline: string[]): string[] {
  const dev = pipeline.indexOf('developer');
  return pipeline.slice(dev + 1);
}

export function firstBuildState(pipeline: string[]): TicketState {
  return pipeline.includes('architect') ? 'DESIGN' : 'READY';
}

export function gateState(name: string): TicketState {
  return name === 'uat' ? 'UAT' : 'IN_REVIEW';
}

function currentGateName(gates: string[], ticket: { status: TicketState; gate: string | null }): string | null {
  if (ticket.gate && gates.includes(ticket.gate) && gateState(ticket.gate) === ticket.status) return ticket.gate;
  return gates.find((g) => gateState(g) === ticket.status) ?? null;
}

export function resolveStage(pipeline: string[], ticket: { status: TicketState; gate: string | null }): ResolvedStage {
  const gates = pipelineGates(pipeline);
  const afterDeveloper: TicketState = gates.length ? gateState(gates[0]!) : 'READY_TO_LAND';

  switch (ticket.status) {
    case 'DRAFT':
      return null;
    case 'BACKLOG':
      return { kind: 'agent', role: 'pm', onPass: 'AWAIT_APPROVAL', onPassGate: null, onFail: 'BLOCKED' };
    case 'AWAIT_APPROVAL':
      return { kind: 'human', onApprove: firstBuildState(pipeline), onReject: 'BLOCKED' };
    case 'DESIGN':
      if (!pipeline.includes('architect')) {
        return { kind: 'skip', to: 'READY', gate: null, note: 'architect is not in the pipeline' };
      }
      return { kind: 'agent', role: 'architect', onPass: 'READY', onPassGate: null, onFail: 'BLOCKED' };
    case 'READY':
    case 'IN_PROGRESS':
      return { kind: 'agent', role: 'developer', onPass: afterDeveloper, onPassGate: gates[0] ?? null, onFail: 'BLOCKED' };
    case 'IN_REVIEW':
    case 'UAT': {
      const name = currentGateName(gates, ticket);
      if (!name) {
        return {
          kind: 'skip',
          to: afterDeveloper === ticket.status ? 'READY_TO_LAND' : afterDeveloper,
          gate: afterDeveloper === ticket.status ? null : (gates[0] ?? null),
          note: `no ${ticket.status} gate is in the pipeline`,
        };
      }
      const next = gates[gates.indexOf(name) + 1];
      return {
        kind: 'agent',
        role: name,
        onPass: next ? gateState(next) : 'READY_TO_LAND',
        onPassGate: next ?? null,
        onFail: 'IN_PROGRESS',
      };
    }
    case 'READY_TO_LAND':
      return { kind: 'land' };
    case 'NEEDS_INTEGRATION':
    case 'DONE':
    case 'CLOSED':
    case 'BLOCKED':
      return null;
  }
}

export function isTerminal(state: TicketState): boolean {
  return state === 'DONE' || state === 'BLOCKED' || state === 'CLOSED';
}

export function isRework(to: TicketState): boolean {
  return to === 'IN_PROGRESS';
}

export function failTarget(stage: { onFail: TicketState }, attempt: number, maxAttempts: number): TicketState {
  if (stage.onFail === 'IN_PROGRESS' && attempt >= maxAttempts) {
    return 'BLOCKED';
  }
  return stage.onFail;
}

export function unblockTarget(
  pipeline: string[],
  blocked: { from: TicketState; role: string | null } | null,
  hasBranch: boolean,
): TicketState {
  const fallback: TicketState = hasBranch ? 'IN_PROGRESS' : 'BACKLOG';
  if (!blocked) return fallback;
  const gates = pipelineGates(pipeline);
  if (blocked.role && gates.includes(blocked.role) && (blocked.from === 'IN_REVIEW' || blocked.from === 'UAT')) {
    return 'IN_PROGRESS';
  }
  switch (blocked.from) {
    case 'BACKLOG':
    case 'AWAIT_APPROVAL':
    case 'DESIGN':
    case 'READY':
    case 'IN_PROGRESS':
    case 'IN_REVIEW':
    case 'UAT':
    case 'READY_TO_LAND':
      return blocked.from;
    default:
      return fallback;
  }
}

export function roleForState(pipeline: string[], state: TicketState): string {
  const stage = resolveStage(pipeline, { status: state, gate: null });
  if (stage && stage.kind === 'agent') return stage.role;
  if (stage && stage.kind === 'human') return 'your decision';
  if (stage && stage.kind === 'land') return 'integration';
  return 'the team';
}
