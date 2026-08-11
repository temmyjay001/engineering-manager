import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConventions } from '../src/agents/conventions';

const FILES = ['CLAUDE.md', 'AGENTS.md'];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-conventions-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConventions', () => {
  it('returns null when no convention file exists', () => {
    expect(loadConventions(FILES, dir)).toBeNull();
  });

  it('returns null when the list is empty', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Use tabs.');
    expect(loadConventions([], dir)).toBeNull();
  });

  it('uses the first existing file in order', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'agents rules');
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude rules');
    const block = loadConventions(FILES, dir);
    expect(block).toContain('CLAUDE.md');
    expect(block).toContain('claude rules');
    expect(block).not.toContain('agents rules');
  });

  it('falls through empty files to the next candidate', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '   \n  ');
    writeFileSync(join(dir, 'AGENTS.md'), 'agents rules');
    const block = loadConventions(FILES, dir);
    expect(block).toContain('AGENTS.md');
    expect(block).toContain('agents rules');
  });

  it('frames the content with precedence guidance', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Never use semicolons.');
    const block = loadConventions(FILES, dir);
    expect(block).toContain('REPOSITORY CONVENTIONS');
    expect(block).toContain('role instructions and constraints still take precedence');
  });

  it('truncates oversized files', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'x'.repeat(20 * 1024));
    const block = loadConventions(FILES, dir)!;
    expect(block).toContain('[truncated');
    expect(block.length).toBeLessThan(18 * 1024);
  });
});
