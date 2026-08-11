import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const TEXT_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_ITEMS = 12;

export interface Evidence {
  name: string;
  mime: string;
  content: string;
}

function listFiles(dir: string): string[] {
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).sort();
  } catch {
    return [];
  }
}

export function snapshotFiles(dir: string): Set<string> {
  return new Set(listFiles(dir));
}

export function collectNewEvidence(dir: string, before: Set<string>, budget: number = MAX_EVIDENCE_ITEMS): Evidence[] {
  const limit = Math.max(0, Math.min(budget, MAX_EVIDENCE_ITEMS));
  const evidence: Evidence[] = [];
  if (limit === 0) return evidence;
  for (const name of listFiles(dir)) {
    if (before.has(name)) continue;
    const ext = extname(name).toLowerCase();
    const imageMime = IMAGE_MIME[ext];
    const mime = imageMime ?? TEXT_MIME[ext];
    if (!mime) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) continue;
      const content = imageMime ? readFileSync(path).toString('base64') : readFileSync(path, 'utf8');
      evidence.push({ name, mime, content });
    } catch {
      continue;
    }
    if (evidence.length >= limit) break;
  }
  return evidence;
}
