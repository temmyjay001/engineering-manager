import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentTokens } from './agents/runner';
import type { Project } from './project';

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface ModelCost {
  input?: number;
  output?: number;
}

type Catalog = Record<string, { models?: Record<string, { cost?: ModelCost }> }>;

function cachePath(project: Project): string {
  return join(project.emDir, 'cache', 'models-dev.json');
}

function readCache(path: string, maxAgeMs: number): Catalog | null {
  try {
    if (!existsSync(path)) return null;
    if (Date.now() - statSync(path).mtimeMs > maxAgeMs) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as Catalog;
  } catch {
    return null;
  }
}

export async function loadCatalog(project: Project): Promise<Catalog | null> {
  const path = cachePath(project);
  const fresh = readCache(path, CACHE_TTL_MS);
  if (fresh) return fresh;
  try {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`catalog fetch failed with ${response.status}`);
    const catalog = (await response.json()) as Catalog;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(catalog));
    return catalog;
  } catch {
    return readCache(path, Number.POSITIVE_INFINITY);
  }
}

export interface ModelListing {
  provider: string;
  id: string;
  inputPer1M: number | null;
  outputPer1M: number | null;
}

export async function listModels(project: Project): Promise<ModelListing[]> {
  const catalog = await loadCatalog(project);
  if (!catalog) return [];
  const out: ModelListing[] = [];
  for (const [provider, entry] of Object.entries(catalog)) {
    const models = entry?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [id, model] of Object.entries(models)) {
      out.push({
        provider,
        id,
        inputPer1M: typeof model?.cost?.input === 'number' ? model.cost.input : null,
        outputPer1M: typeof model?.cost?.output === 'number' ? model.cost.output : null,
      });
    }
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

export function findModelCost(catalog: Catalog, model: string): ModelCost | null {
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  for (const provider of Object.values(catalog)) {
    const models = provider?.models;
    if (!models || typeof models !== 'object') continue;
    const entry = models[model] ?? models[bare];
    const cost = entry?.cost;
    if (cost && (typeof cost.input === 'number' || typeof cost.output === 'number')) return cost;
  }
  return null;
}

export function costFromTokens(cost: ModelCost, tokens: AgentTokens): number {
  return ((cost.input ?? 0) * tokens.input + (cost.output ?? 0) * tokens.output) / 1_000_000;
}

export async function estimateCostUsd(project: Project, model: string, tokens: AgentTokens): Promise<number | null> {
  if (tokens.input === 0 && tokens.output === 0) return null;
  const catalog = await loadCatalog(project);
  if (!catalog) return null;
  const cost = findModelCost(catalog, model);
  if (!cost) return null;
  return costFromTokens(cost, tokens);
}
