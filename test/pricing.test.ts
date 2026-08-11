import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costFromTokens, findModelCost, loadCatalog } from '../src/pricing';
import type { Project } from '../src/project';

const catalog = {
  openai: {
    models: {
      'gpt-5.1-codex-mini': { cost: { input: 0.25, output: 2 } },
    },
  },
  google: {
    models: {
      'gemini-3.5-flash': { cost: { input: 0.3, output: 2.5 } },
    },
  },
  anthropic: {
    models: {
      'claude-opus-4-8': { cost: { input: 5, output: 25 } },
    },
  },
};

describe('pricing', () => {
  it('finds models by bare id and provider-prefixed id', () => {
    expect(findModelCost(catalog, 'gpt-5.1-codex-mini')).toEqual({ input: 0.25, output: 2 });
    expect(findModelCost(catalog, 'openai/gpt-5.1-codex-mini')).toEqual({ input: 0.25, output: 2 });
    expect(findModelCost(catalog, 'gemini-3.5-flash')).toEqual({ input: 0.3, output: 2.5 });
    expect(findModelCost(catalog, 'unknown-model')).toBeNull();
  });

  it('computes cost per million tokens', () => {
    const cost = costFromTokens(
      { input: 0.25, output: 2 },
      { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 },
    );
    expect(cost).toBeCloseTo(0.25 + 1.0);
  });

  describe('catalog cache', () => {
    let dir: string;
    let project: Project;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'em-pricing-'));
      project = { emDir: dir } as Project;
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('serves a fresh cache without fetching', async () => {
      mkdirSync(join(dir, 'cache'), { recursive: true });
      writeFileSync(join(dir, 'cache', 'models-dev.json'), JSON.stringify(catalog));
      const loaded = await loadCatalog(project);
      expect(loaded).not.toBeNull();
      expect(findModelCost(loaded!, 'gemini-3.5-flash')).toEqual({ input: 0.3, output: 2.5 });
    });
  });
});
