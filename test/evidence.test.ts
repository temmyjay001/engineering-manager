import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectNewEvidence, snapshotFiles } from '../src/agents/evidence';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-evidence-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('evidence collection', () => {
  it('collects only images created after the snapshot', () => {
    writeFileSync(join(dir, 'old.png'), Buffer.from([1, 2, 3]));
    const before = snapshotFiles(dir);

    writeFileSync(join(dir, 'new.png'), Buffer.from([4, 5, 6]));
    writeFileSync(join(dir, 'notes.csv'), 'not evidence');
    mkdirSync(join(dir, 'shots'));
    writeFileSync(join(dir, 'shots', 'nested.jpg'), Buffer.from([7, 8]));

    const evidence = collectNewEvidence(dir, before);
    expect(evidence.map((i) => i.name)).toEqual(['new.png', join('shots', 'nested.jpg')]);
    expect(evidence[0]).toMatchObject({ mime: 'image/png', content: Buffer.from([4, 5, 6]).toString('base64') });
    expect(evidence[1]?.mime).toBe('image/jpeg');
  });

  it('collects text snapshots alongside images, storing raw text content', () => {
    const before = snapshotFiles(dir);
    writeFileSync(join(dir, 'shot.png'), Buffer.from([1]));
    writeFileSync(join(dir, 'a11y.txt'), 'button "Save" [enabled]');

    const evidence = collectNewEvidence(dir, before);
    expect(evidence.map((i) => i.name).sort()).toEqual(['a11y.txt', 'shot.png']);
    const snapshot = evidence.find((i) => i.name === 'a11y.txt')!;
    expect(snapshot.mime).toBe('text/plain');
    expect(snapshot.content).toBe('button "Save" [enabled]');
  });

  it('skips oversized images', () => {
    const before = snapshotFiles(dir);
    writeFileSync(join(dir, 'huge.png'), Buffer.alloc(2 * 1024 * 1024 + 1));
    writeFileSync(join(dir, 'ok.webp'), Buffer.from([1]));
    expect(collectNewEvidence(dir, before).map((i) => i.name)).toEqual(['ok.webp']);
  });

  it('caps the number of collected items', () => {
    const before = snapshotFiles(dir);
    for (let i = 0; i < 15; i += 1) writeFileSync(join(dir, `shot-${String(i).padStart(2, '0')}.png`), Buffer.from([i]));
    expect(collectNewEvidence(dir, before)).toHaveLength(12);
  });

  it('honors a budget smaller than the hard cap', () => {
    const before = snapshotFiles(dir);
    for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `shot-${i}.png`), Buffer.from([i]));
    expect(collectNewEvidence(dir, before, 2)).toHaveLength(2);
    expect(collectNewEvidence(dir, before, 0)).toHaveLength(0);
  });

  it('tolerates a missing directory', () => {
    const missing = join(dir, 'nope');
    expect(snapshotFiles(missing).size).toBe(0);
    expect(collectNewEvidence(missing, new Set())).toEqual([]);
  });
});
