export interface LeadTimeStats {
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
}

export interface KeyedUsd {
  key: string;
  usd: number;
}

export interface RoleRunStats {
  role: string;
  runs: number;
  errors: number;
  avgDurationMs: number;
}

export interface RoleTokenStats {
  role: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LifetimeStats {
  totalTokens: number;
  runs: number;
  totalUsd: number;
}

export interface Report {
  windowDays: number | null;
  lifetime: LifetimeStats;
  tickets: {
    done: number;
    open: number;
    blocked: number;
    firstPass: number;
    avgAttempts: number | null;
    leadTime: LeadTimeStats | null;
    agentTimeMs: number;
  };
  throughput: Array<{ bucket: string; done: number }>;
  gates: {
    reviewFails: number;
    uatFails: number;
    humanRejections: number;
    autoApprovals: number;
  };
  spend: {
    totalUsd: number;
    perDoneTicketUsd: number | null;
    byRole: KeyedUsd[];
    byRunner: KeyedUsd[];
    byModel: KeyedUsd[];
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    tokensByRole: RoleTokenStats[];
  };
  runs: {
    total: number;
    errors: number;
    byRole: RoleRunStats[];
  };
  month: {
    spentUsd: number;
    budgetUsd: number | null;
  };
}

const PREMIUM_MODEL = /opus|fable/i;
const MID_TIER_SUGGESTION = 'claude-sonnet-5';

export function adviceFor(report: Report, roleModels: Record<string, string | undefined>, defaultModel: string): string[] {
  const advice: string[] = [];

  const top = report.spend.byRole[0];
  if (top && report.spend.totalUsd >= 1 && top.usd / report.spend.totalUsd >= 0.4) {
    const model = roleModels[top.key] ?? defaultModel;
    if (PREMIUM_MODEL.test(model)) {
      const share = Math.round((top.usd / report.spend.totalUsd) * 100);
      advice.push(
        `${top.key} is ${share}% of spend on ${model}. Try ${MID_TIER_SUGGESTION} for a few tickets, then compare defects caught and first-pass rate here.`,
      );
    }
  }

  if (report.runs.total >= 5 && report.runs.errors / report.runs.total >= 0.2) {
    const pct = Math.round((report.runs.errors / report.runs.total) * 100);
    advice.push(`${pct}% of agent runs errored; failed runs still bill tokens, check the erroring role and runner pairing.`);
  }

  if (report.month.budgetUsd !== null && report.month.spentUsd / report.month.budgetUsd >= 0.8) {
    const pct = Math.round((report.month.spentUsd / report.month.budgetUsd) * 100);
    advice.push(
      `Month-to-date spend is $${report.month.spentUsd.toFixed(2)} of the $${report.month.budgetUsd.toFixed(2)} budget (${pct}%).`,
    );
  }

  return advice;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

export function leadTimeStats(leadMs: number[]): LeadTimeStats | null {
  if (leadMs.length === 0) return null;
  const sorted = [...leadMs].sort((a, b) => a - b);
  const avg = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return {
    avgMs: Math.round(avg),
    p50Ms: Math.round(percentile(sorted, 50)),
    p90Ms: Math.round(percentile(sorted, 90)),
  };
}
