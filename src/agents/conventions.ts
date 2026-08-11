import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_CONVENTION_CHARS = 16 * 1024;

export function loadConventions(files: string[], cwd: string): string | null {
  for (const name of files) {
    let content: string;
    try {
      content = readFileSync(join(cwd, name), 'utf8').trim();
    } catch {
      continue;
    }
    if (!content) continue;
    if (content.length > MAX_CONVENTION_CHARS) {
      content = `${content.slice(0, MAX_CONVENTION_CHARS)}\n[truncated: file exceeds ${MAX_CONVENTION_CHARS} characters]`;
    }
    return [
      'REPOSITORY CONVENTIONS',
      `The target repository defines its working conventions in ${name}. Follow them wherever they apply to your work; your role instructions and constraints still take precedence if they conflict.`,
      '',
      content,
    ].join('\n');
  }
  return null;
}
