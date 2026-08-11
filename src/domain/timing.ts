import type { Transition } from './types';

export function parseDbDate(value: string): number {
  return new Date(`${value.replace(' ', 'T')}Z`).getTime();
}

export function ticketLeadTimeMs(
  ticket: { createdAt: string; status: string },
  transitions: Transition[],
): number | null {
  if (ticket.status !== 'DONE') return null;
  const done = [...transitions].reverse().find((t) => t.toState === 'DONE');
  if (!done) return null;
  return Math.max(0, parseDbDate(done.createdAt) - parseDbDate(ticket.createdAt));
}

export function epicLeadTimeMs(epic: { createdAt: string; updatedAt: string; status: string }): number | null {
  if (epic.status !== 'DONE') return null;
  return Math.max(0, parseDbDate(epic.updatedAt) - parseDbDate(epic.createdAt));
}

export function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
