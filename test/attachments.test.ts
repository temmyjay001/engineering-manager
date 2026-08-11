import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentsBlock } from '../src/agents/context';
import { Store } from '../src/db/store';
import { parseEmConfig, type Project } from '../src/project';
import { parseImageAttachments } from '../src/web/api';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

describe('parseImageAttachments', () => {
  it('accepts a valid list and defaults to empty', () => {
    expect(parseImageAttachments(undefined)).toEqual([]);
    const parsed = parseImageAttachments([{ name: 'mock.png', mime: 'image/png', dataBase64: PNG }]);
    expect(parsed).toHaveLength(1);
  });

  it('rejects bad shapes, non-images, oversize, and too many', () => {
    expect(parseImageAttachments('x')).toMatch(/array/);
    expect(parseImageAttachments([{ name: 'a' }])).toMatch(/needs name, mime/);
    expect(parseImageAttachments([{ name: 'a.pdf', mime: 'application/pdf', dataBase64: PNG }])).toMatch(/only image/);
    const big = Buffer.alloc(3 * 1024 * 1024).toString('base64');
    expect(parseImageAttachments([{ name: 'big.png', mime: 'image/png', dataBase64: big }])).toMatch(/capped/);
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `${i}.png`, mime: 'image/png', dataBase64: PNG }));
    expect(parseImageAttachments(many)).toMatch(/at most 5/);
  });
});

describe('attachmentsBlock', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-attach-'));
    store = new Store(join(dir, 'eng.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes attachments to scratch files and references them in the prompt', () => {
    const parsed = parseEmConfig({});
    if ('error' in parsed) throw new Error(parsed.error);
    const project: Project = {
      root: dir,
      emDir: join(dir, '.em'),
      dbPath: join(dir, 'eng.db'),
      worktreesDir: join(dir, '.em', 'worktrees'),
      scratchDir: join(dir, '.em', 'scratch'),
      configPath: join(dir, '.em', 'config.json'),
      config: parsed.config,
    };
    const t = store.createTicket({ title: 'x', description: 'y' });
    expect(attachmentsBlock(store, project, t)).toBeNull();

    store.addArtifact(t.id, 'ATTACHMENT', 'human', PNG, { name: 'mockup.png', mime: 'image/png' });
    const block = attachmentsBlock(store, project, t)!;
    expect(block).toContain('mockup.png');
    const path = /- mockup\.png: (.+)$/m.exec(block)![1]!;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
