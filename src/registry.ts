import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface ProjectEntry {
  id: string;
  name: string;
  root: string;
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), '.config');
  return join(base, 'emorg');
}

function registryPath(): string {
  return join(configDir(), 'projects.json');
}

function projectId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 8);
}

function toEntry(root: string): ProjectEntry {
  return { id: projectId(root), name: basename(root), root };
}

function readRoots(): string[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is string => typeof r === 'string');
  } catch {
    return [];
  }
}

function writeRoots(roots: string[]): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(roots, null, 2)}\n`);
}

export function registerProject(root: string): void {
  const abs = resolve(root);
  const roots = readRoots();
  if (!roots.includes(abs)) {
    roots.push(abs);
    writeRoots(roots);
  }
}

export function listProjects(): ProjectEntry[] {
  return readRoots()
    .filter((root) => existsSync(join(root, '.em')))
    .map(toEntry);
}

export function findProjectEntry(id: string): ProjectEntry | undefined {
  return listProjects().find((p) => p.id === id);
}
