import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchReport } from '@/lib/api';
import { duration, money } from '@/lib/format';
import { useResource } from '@/lib/hooks';
import type { Report } from '@/lib/types';

type Window = '7' | '30' | '90' | 'all';

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}

function LifetimeStat({ lifetime }: { lifetime: Report['lifetime'] }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-6">
        <p className="text-xs text-muted-foreground">Lifetime tokens processed</p>
        <p className="text-4xl font-bold tracking-tight tabular-nums">{lifetime.totalTokens.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground">
          {lifetime.runs.toLocaleString()} runs · {money(lifetime.totalUsd)} · since the project began, ignores the window filter
        </p>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function SpendTable({ label, rows }: { label: string; rows: Array<{ key: string; usd: number }> }) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.usd));
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-3 text-sm">
            <span className="w-44 truncate font-mono text-xs">{r.key}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground/60" style={{ width: `${(r.usd / max) * 100}%` }} />
            </div>
            <span className="w-16 text-right text-xs tabular-nums">{money(r.usd)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReportsView({ projectId }: { projectId: string }) {
  const [window, setWindow] = useState<Window>('30');
  const { data, error } = useResource<Report>(
    () => fetchReport(projectId, window === 'all' ? 'all' : Number(window)),
    [projectId, window],
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <Select value={window} onValueChange={(v) => setWindow(v as Window)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
            <SelectItem value="all">All time</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error ? <p className="mt-6 text-sm text-destructive">Failed to load: {error}</p> : null}
      {!data && !error ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : null}

      {data ? (
        <div className="mt-8 space-y-10">
          <LifetimeStat lifetime={data.lifetime} />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Tickets done"
              value={String(data.tickets.done)}
              detail={`${data.tickets.open} open, ${data.tickets.blocked} blocked`}
            />
            <Stat
              label="Lead time (p50)"
              value={data.tickets.leadTime ? duration(data.tickets.leadTime.p50Ms) : 'n/a'}
              detail={
                data.tickets.leadTime
                  ? `avg ${duration(data.tickets.leadTime.avgMs)}, p90 ${duration(data.tickets.leadTime.p90Ms)}`
                  : 'no completed tickets'
              }
            />
            <Stat
              label="First pass"
              value={data.tickets.done > 0 ? `${Math.round((data.tickets.firstPass / data.tickets.done) * 100)}%` : 'n/a'}
              detail={
                data.tickets.done > 0
                  ? `${data.tickets.firstPass}/${data.tickets.done} without rework`
                  : 'no completed tickets'
              }
            />
            <Stat
              label="Spend"
              value={money(data.spend.totalUsd)}
              detail={[
                data.spend.perDoneTicketUsd !== null ? `${money(data.spend.perDoneTicketUsd)} per done ticket` : null,
                data.month.budgetUsd !== null
                  ? `${money(data.month.spentUsd)} of ${money(data.month.budgetUsd)} this month`
                  : null,
              ]
                .filter(Boolean)
                .join(', ') || undefined}
            />
          </div>

          {data.advice && data.advice.length > 0 ? (
            <Card>
              <CardContent className="space-y-2 p-4">
                <p className="text-xs font-medium text-muted-foreground">Advice</p>
                {data.advice.map((line) => (
                  <p key={line} className="text-sm leading-relaxed">
                    {line}
                  </p>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {data.throughput.length > 0 ? (
            <Section title="Throughput">
              <div className="space-y-1">
                {data.throughput.map(({ bucket, done }) => {
                  const max = Math.max(...data.throughput.map((b) => b.done));
                  return (
                    <div key={bucket} className="flex items-center gap-3 text-sm">
                      <span className="w-24 font-mono text-xs text-muted-foreground">{bucket}</span>
                      <div className="h-4 flex-1 overflow-hidden rounded-sm bg-muted">
                        <div className="h-full rounded-sm bg-foreground/70" style={{ width: `${(done / max) * 100}%` }} />
                      </div>
                      <span className="w-8 text-right text-xs tabular-nums">{done}</span>
                    </div>
                  );
                })}
              </div>
            </Section>
          ) : null}

          <Section title="Quality gates">
            <div className="grid gap-4 sm:grid-cols-4">
              <Stat
                label="Defects caught"
                value={String(data.gates.reviewFails + data.gates.uatFails)}
                detail={`review ${data.gates.reviewFails}, uat ${data.gates.uatFails}`}
              />
              <Stat label="Human rejections" value={String(data.gates.humanRejections)} />
              <Stat label="Auto-approvals" value={String(data.gates.autoApprovals)} />
              <Stat
                label="Agent time"
                value={data.tickets.agentTimeMs > 0 ? duration(data.tickets.agentTimeMs) : '0s'}
                detail={
                  data.tickets.avgAttempts !== null ? `avg attempts ${data.tickets.avgAttempts.toFixed(1)}` : undefined
                }
              />
            </div>
          </Section>

          {data.spend.totalUsd > 0 ? (
            <Section title="Spend breakdown">
              <Card>
                <CardContent className="space-y-5 p-4">
                  <SpendTable label="By role" rows={data.spend.byRole} />
                  <SpendTable label="By runner" rows={data.spend.byRunner} />
                  <SpendTable label="By model" rows={data.spend.byModel} />
                  {data.spend.inputTokens > 0 ||
                  data.spend.outputTokens > 0 ||
                  data.spend.cacheReadTokens > 0 ||
                  data.spend.cacheWriteTokens > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {data.spend.inputTokens.toLocaleString()} tokens in, {data.spend.outputTokens.toLocaleString()} out,{' '}
                      {data.spend.cacheReadTokens.toLocaleString()} cache read, {data.spend.cacheWriteTokens.toLocaleString()} cache
                      write
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </Section>
          ) : null}

          {data.spend.tokensByRole.length > 0 ? (
            <Section title="Tokens by role">
              <div className="divide-y overflow-hidden rounded-lg border">
                <div className="flex items-center gap-3 bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
                  <span className="w-24">Role</span>
                  <span className="flex-1 text-right">In</span>
                  <span className="flex-1 text-right">Out</span>
                  <span className="flex-1 text-right">Cache read</span>
                  <span className="flex-1 text-right">Cache write</span>
                </div>
                {data.spend.tokensByRole.map((row) => (
                  <div key={row.role} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="w-24 capitalize">{row.role}</span>
                    <span className="flex-1 text-right tabular-nums">{row.inputTokens.toLocaleString()}</span>
                    <span className="flex-1 text-right tabular-nums">{row.outputTokens.toLocaleString()}</span>
                    <span className="flex-1 text-right tabular-nums">{row.cacheReadTokens.toLocaleString()}</span>
                    <span className="flex-1 text-right tabular-nums">{row.cacheWriteTokens.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </Section>
          ) : null}

          {data.runs.total > 0 ? (
            <Section title="Agent runs">
              <div className="divide-y overflow-hidden rounded-lg border">
                <div className="flex items-center gap-3 bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
                  <span className="w-24">Role</span>
                  <span className="w-16 text-right">Runs</span>
                  <span className="w-16 text-right">Errors</span>
                  <span className="flex-1 text-right">Avg duration</span>
                </div>
                {data.runs.byRole.map((row) => (
                  <div key={row.role} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="w-24 capitalize">{row.role}</span>
                    <span className="w-16 text-right tabular-nums">{row.runs}</span>
                    <span className={`w-16 text-right tabular-nums ${row.errors > 0 ? 'text-destructive' : ''}`}>
                      {row.errors}
                    </span>
                    <span className="flex-1 text-right text-xs text-muted-foreground">{duration(row.avgDurationMs)}</span>
                  </div>
                ))}
                <div className="flex items-center gap-3 px-4 py-2 text-xs text-muted-foreground">
                  <span>{data.runs.total} runs total, {data.runs.errors} errors</span>
                </div>
              </div>
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
