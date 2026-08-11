import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db/store';
import type { ArtifactKind, Ticket } from '../domain/types';
import { scratchPath } from '../git/worktree';
import type { Project } from '../project';

export function ticketBlock(ticket: Ticket): string {
  const labels = ticket.labels.length > 0 ? ticket.labels.join(', ') : 'none';
  return `Ticket ${ticket.key}: ${ticket.title || '(untitled)'}\n\nPriority: ${ticket.priority}\nLabels: ${labels}\n\nOriginal request:\n${ticket.description}`;
}

export function criteriaBlock(store: Store, ticket: Ticket): string {
  const cs = store.getCriteria(ticket.id);
  if (cs.length === 0) return 'No acceptance criteria recorded.';
  return cs.map((c) => `${c.idx}. [${c.isUi ? 'UI' : 'non-UI'}] ${c.text}`).join('\n');
}

export function latest(store: Store, ticket: Ticket, kind: ArtifactKind): string | null {
  return store.latestArtifact(ticket.id, kind)?.content ?? null;
}

const DEFECT_KINDS = new Set<ArtifactKind>(['REVIEW', 'UAT', 'GUIDANCE']);

export function latestDefect(store: Store, ticket: Ticket): { kind: ArtifactKind; content: string } | null {
  const reports = store.getArtifacts(ticket.id).filter((a) => DEFECT_KINDS.has(a.kind));
  const last = reports.at(-1);
  return last ? { kind: last.kind, content: last.content } : null;
}

export function attachmentsBlock(store: Store, project: Project, ticket: Ticket): string | null {
  const attachments = store.getArtifacts(ticket.id).filter((a) => a.kind === 'ATTACHMENT');
  if (attachments.length === 0) return null;
  const dir = join(scratchPath(project, ticket.key), 'attachments');
  mkdirSync(dir, { recursive: true });
  const lines = attachments.map((a) => {
    const meta = a.data ? (JSON.parse(a.data) as { name?: string }) : {};
    const name = meta.name ?? `attachment-${a.id}.png`;
    const path = join(dir, `${a.id}-${name.replaceAll('/', '_')}`);
    writeFileSync(path, Buffer.from(a.content, 'base64'));
    return `- ${name}: ${path}`;
  });
  return [
    'The stakeholder attached images to this ticket (screenshots, mockups, or diagrams).',
    'View them with your file reading tool before deciding; they are part of the request:',
    ...lines,
  ].join('\n');
}
