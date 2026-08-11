import { useSyncExternalStore } from 'react';

function currentHash(): string {
  return globalThis.location.hash.replace(/^#/, '') || '/';
}

function subscribe(callback: () => void): () => void {
  globalThis.addEventListener('hashchange', callback);
  return () => globalThis.removeEventListener('hashchange', callback);
}

export interface Route {
  name: 'root' | 'board' | 'ticket' | 'draft' | 'epics' | 'epic' | 'settings' | 'reports' | 'meetings' | 'backlog' | 'notfound';
  projectId?: string;
  key?: string;
}

export function parseRoute(path: string): Route {
  const seg = path.split('/').filter(Boolean);
  if (seg.length === 0) return { name: 'root' };
  if (seg[0] !== 'p' || !seg[1]) return { name: 'notfound' };
  const projectId = seg[1];
  if (seg.length === 2) return { name: 'board', projectId };
  if (seg[2] === 'tickets' && seg[3] && seg[4] === 'draft') return { name: 'draft', projectId, key: decodeURIComponent(seg[3]) };
  if (seg[2] === 'tickets' && seg[3]) return { name: 'ticket', projectId, key: decodeURIComponent(seg[3]) };
  if (seg[2] === 'epics' && seg[3]) return { name: 'epic', projectId, key: decodeURIComponent(seg[3]) };
  if (seg[2] === 'epics') return { name: 'epics', projectId };
  if (seg[2] === 'settings') return { name: 'settings', projectId };
  if (seg[2] === 'reports') return { name: 'reports', projectId };
  if (seg[2] === 'meetings') return { name: 'meetings', projectId, key: seg[3] ? decodeURIComponent(seg[3]) : undefined };
  if (seg[2] === 'backlog') return { name: 'backlog', projectId };
  return { name: 'notfound' };
}

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, currentHash, () => '/');
  return parseRoute(path);
}

export function navigate(to: string): void {
  globalThis.location.hash = to;
}

export function projectPath(projectId: string, sub = ''): string {
  return `/p/${projectId}${sub}`;
}

export function projectHref(projectId: string, sub = ''): string {
  return `#${projectPath(projectId, sub)}`;
}
