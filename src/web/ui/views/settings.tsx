import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ModelCombobox } from '@/components/model-combobox';
import { fetchConfig, fetchModels, saveConfig, type ModelListing } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import type { ConfigResponse, EmConfig, RoleOverride } from '@/lib/types';

const PROFILES: Record<string, Record<string, string>> = {
  economy: {
    planner: 'claude-haiku-4-5',
    pm: 'claude-haiku-4-5',
    architect: 'claude-sonnet-5',
    developer: 'claude-sonnet-5',
    reviewer: 'claude-sonnet-5',
    uat: 'claude-sonnet-5',
  },
  balanced: {
    planner: 'claude-sonnet-5',
    pm: 'claude-sonnet-5',
    architect: 'claude-opus-4-8',
    developer: 'claude-opus-4-8',
    reviewer: 'claude-sonnet-5',
    uat: 'claude-sonnet-5',
  },
  premium: {
    planner: 'claude-opus-4-8',
    pm: 'claude-opus-4-8',
    architect: 'claude-opus-4-8',
    developer: 'claude-opus-4-8',
    reviewer: 'claude-opus-4-8',
    uat: 'claude-opus-4-8',
  },
};

function activeProfile(config: EmConfig, defaults: Record<string, string>): string | null {
  for (const [name, roleModels] of Object.entries(PROFILES)) {
    const matches = Object.entries(roleModels).every(
      ([role, model]) => (config.roles[role]?.model ?? defaults[role]) === model,
    );
    if (matches) return name;
  }
  return null;
}

const RUNNER_PROVIDERS: Record<string, string[]> = {
  'claude-sdk': ['anthropic'],
  'claude-cli': ['anthropic'],
  codex: ['openai'],
  gemini: ['google'],
  'gemini-acp': ['google'],
};

function modelSuggestions(models: ModelListing[], runner: string): Array<{ value: string; price: string }> {
  const providers = RUNNER_PROVIDERS[runner];
  const prefixed = runner === 'opencode' || runner === 'opencode-server';
  return models
    .filter((m) => !providers || providers.includes(m.provider))
    .map((m) => ({
      value: prefixed ? `${m.provider}/${m.id}` : m.id,
      price: m.inputPer1M !== null ? `$${m.inputPer1M}/M in, $${m.outputPer1M ?? '?'}/M out` : '',
    }));
}

function priceOf(models: ModelListing[], value: string): string | null {
  const bare = value.includes('/') ? value.slice(value.indexOf('/') + 1) : value;
  const hit = models.find((m) => m.id === value || m.id === bare);
  if (!hit || hit.inputPer1M === null) return null;
  return `$${hit.inputPer1M}/M input, $${hit.outputPer1M ?? '?'}/M output`;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function RoleCard({
  role,
  override,
  data,
  models,
  onChange,
}: {
  role: string;
  override: RoleOverride;
  data: ConfigResponse;
  models: ModelListing[];
  onChange: (next: RoleOverride) => void;
}) {
  const runnerValue = override.runner ?? 'claude-sdk';
  const suggestions = modelSuggestions(models, runnerValue);
  const currentPrice = priceOf(models, override.model ?? data.defaults.models[role] ?? '');
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium capitalize">{role}</h3>
      <Field label="Runner">
        <Select value={runnerValue} onValueChange={(v) => onChange({ ...override, runner: v === 'claude-sdk' ? undefined : v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {data.availableRunners.map((r) => (
              <SelectItem key={r} value={r}>
                {r === 'claude-sdk' ? 'claude-sdk (default)' : r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Model" hint={currentPrice ?? undefined}>
        <ModelCombobox
          value={override.model ?? ''}
          placeholder={data.defaults.models[role]}
          options={suggestions}
          onChange={(next) => onChange({ ...override, model: next.trim() || undefined })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max turns">
          <Input
            value={override.maxTurns != null ? String(override.maxTurns) : ''}
            placeholder={String(data.defaults.maxTurns[role])}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ ...override, maxTurns: Number.isFinite(n) && n > 0 ? Math.round(n) : undefined });
            }}
          />
        </Field>
        <Field label="Budget USD">
          <Input
            value={override.maxBudgetUsd != null ? String(override.maxBudgetUsd) : ''}
            placeholder="none"
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ ...override, maxBudgetUsd: Number.isFinite(n) && n > 0 ? n : undefined });
            }}
          />
        </Field>
      </div>
      <Field
        label="Escalation ladder"
        hint="Comma-separated models; attempt 1 uses the first, each rework failure escalates to the next. Overrides Model when set"
      >
        <Input
          value={(override.escalation ?? []).join(', ')}
          placeholder="none"
          onChange={(e) => {
            const models = e.target.value
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
            onChange({ ...override, escalation: models.length ? models : undefined });
          }}
        />
      </Field>
      <Field label="MCP servers" hint="Comma-separated names from the MCP servers section; claude runners only">
        <Input
          value={(override.mcpServers ?? []).join(', ')}
          placeholder="none"
          onChange={(e) => {
            const names = e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            onChange({ ...override, mcpServers: names.length ? names : undefined });
          }}
        />
      </Field>
    </div>
  );
}

export function SettingsView({ projectId }: { projectId: string }) {
  const { data, error } = useResource(() => fetchConfig(projectId), [projectId]);
  const { data: models } = useResource(() => fetchModels(projectId), [projectId]);
  const [config, setConfig] = useState<EmConfig | null>(null);
  const [runnersText, setRunnersText] = useState('{}');
  const [mcpText, setMcpText] = useState('{}');
  const [limits, setLimits] = useState({ parallel: '3', attempts: '3' });
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setConfig(data.config);
      setRunnersText(JSON.stringify(data.config.runners ?? {}, null, 2));
      setMcpText(JSON.stringify(data.config.mcpServers ?? {}, null, 2));
      setLimits({
        parallel: String(data.config.maxParallelSubtickets),
        attempts: String(data.config.maxAttempts),
      });
    }
  }, [data]);

  const current = config && data ? activeProfile(config, data.defaults.models) : null;

  const applyProfile = (name: string) => {
    if (!config) return;
    const roles = { ...config.roles };
    for (const [role, model] of Object.entries(PROFILES[name] ?? {})) {
      roles[role] = { ...roles[role], model };
    }
    setConfig({ ...config, roles });
    setMessage(`${name} profile applied to role models; review and save.`);
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);
    try {
      const runners = JSON.parse(runnersText || '{}');
      const mcpServers = JSON.parse(mcpText || '{}');
      const roles = Object.fromEntries(
        Object.entries(config.roles).filter(([, v]) => v && Object.keys(v).length > 0),
      );
      await saveConfig(projectId, {
        ...config,
        roles,
        runners,
        mcpServers,
        maxParallelSubtickets: Number(limits.parallel),
        maxAttempts: Number(limits.attempts),
      });
      setMessage('Saved.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
      {config && data ? (
        <div className="mt-8 space-y-8">
          <section className="space-y-4">
            <h2 className="text-sm font-semibold tracking-tight">Project</h2>
            <Field label="Run command" hint="How UAT starts the app">
              <Input
                value={config.runCommand ?? ''}
                placeholder="npm run dev"
                onChange={(e) => setConfig({ ...config, runCommand: e.target.value.trim() || null })}
              />
            </Field>
            <Field label="App URL" hint="Where UAT reaches the app">
              <Input
                value={config.appUrl ?? ''}
                placeholder="http://localhost:3000"
                onChange={(e) => setConfig({ ...config, appUrl: e.target.value.trim() || null })}
              />
            </Field>
            <Field label="Verify command" hint="Runs against the merged tree before a ticket lands; a failure parks the ticket as Needs integration">
              <Input
                value={config.verifyCommand ?? ''}
                placeholder="npm test"
                onChange={(e) => setConfig({ ...config, verifyCommand: e.target.value.trim() || null })}
              />
            </Field>
            <Field label="Merge strategy" hint="What happens when a ticket reaches DONE">
              <Select value={config.mergeStrategy} onValueChange={(v) => setConfig({ ...config, mergeStrategy: v as EmConfig['mergeStrategy'] })}>
                <SelectTrigger className="max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="merge">merge</SelectItem>
                  <SelectItem value="pr">pr</SelectItem>
                  <SelectItem value="none">none</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Base branch" hint="Branch tickets start from and merge back into; blank means the currently checked-out branch">
              <Input
                value={config.baseBranch ?? ''}
                placeholder="current branch"
                onChange={(e) => setConfig({ ...config, baseBranch: e.target.value.trim() || null })}
              />
            </Field>
            <Field
              label="Convention files"
              hint="Checked in order at the agent's working directory; the first match is added to every agent prompt as repository conventions. Comma-separated; clear to disable"
            >
              <Input
                value={config.conventionFiles.join(', ')}
                placeholder="CLAUDE.md, AGENTS.md"
                onChange={(e) =>
                  setConfig({
                    ...config,
                    conventionFiles: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold tracking-tight">Naming</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Ticket prefix" hint="Keys like EM-12; also used for branch names and commits. Applies to new tickets only">
                <Input
                  value={config.ticketPrefix}
                  onChange={(e) => setConfig({ ...config, ticketPrefix: e.target.value.toUpperCase().trim() })}
                />
              </Field>
              <Field label="Epic prefix" hint="Keys like EP-3; must differ from the ticket prefix">
                <Input
                  value={config.epicPrefix}
                  onChange={(e) => setConfig({ ...config, epicPrefix: e.target.value.toUpperCase().trim() })}
                />
              </Field>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold tracking-tight">Pipeline</h2>
            <Field
              label="Stages"
              hint="Ordered, comma-separated. Built-ins: pm, architect, developer, reviewer, uat (pm and developer required; approval sits after pm). Any other name is a custom gate after developer and needs a prompt at .em/roles/<name>.md"
            >
              <Input
                value={config.pipeline.join(', ')}
                placeholder="pm, architect, developer, reviewer, uat"
                onChange={(e) =>
                  setConfig({
                    ...config,
                    pipeline: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
            <Field
              label="Meeting model"
              hint="Model for meeting replies and minutes across all roles; blank uses each role's own model"
            >
              <Input
                value={config.meetingModel ?? ''}
                placeholder="role default"
                onChange={(e) => setConfig({ ...config, meetingModel: e.target.value.trim() || null })}
              />
            </Field>
            <Field
              label="Meeting turn budget"
              hint="Max turns allowed per meeting message, independent of each role's pipeline turn budget; blank uses the default"
            >
              <Input
                value={config.meetingMaxTurns != null ? String(config.meetingMaxTurns) : ''}
                placeholder={String(data.defaults.meetingMaxTurns)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setConfig({ ...config, meetingMaxTurns: Number.isFinite(n) && n > 0 ? Math.round(n) : null });
                }}
              />
            </Field>
            <Field
              label="Approval mode"
              hint="always: every ticket and epic plan waits for you. epic-once: approving an epic plan lets its subtickets run through; standalone tickets still wait. never: nothing waits, plans materialize on their own"
            >
              <Select value={config.approvalMode} onValueChange={(v) => setConfig({ ...config, approvalMode: v as EmConfig['approvalMode'] })}>
                <SelectTrigger className="max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">always</SelectItem>
                  <SelectItem value="epic-once">epic-once</SelectItem>
                  <SelectItem value="never">never</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Auto-resume interrupted runs"
              hint="When the dashboard starts, automatically resume tickets whose run was interrupted by a crash or restart"
            >
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config.autoResumeInterrupted}
                  onChange={(e) => setConfig({ ...config, autoResumeInterrupted: e.target.checked })}
                />
                Resume automatically on server startup
              </label>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Parallel subtickets" hint="How many epic subtickets build at once (1-8)">
                <Input value={limits.parallel} onChange={(e) => setLimits({ ...limits, parallel: e.target.value })} />
              </Field>
              <Field label="Max attempts" hint="Failed gates retry until this attempt count, then the ticket blocks (1-10)">
                <Input value={limits.attempts} onChange={(e) => setLimits({ ...limits, attempts: e.target.value })} />
              </Field>
            </div>
            <Field label="Monthly budget USD" hint="Burn line shown in reports and em report; advisory, does not stop runs. Blank disables">
              <Input
                value={config.monthlyBudgetUsd ?? ''}
                placeholder="none"
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setConfig({ ...config, monthlyBudgetUsd: Number.isFinite(n) && n > 0 ? n : null });
                }}
              />
            </Field>
            <Field label="Ticket budget USD" hint="Soft cap per ticket, checked before each stage; the ticket blocks once crossed, so it can finish up to one stage over. Blank disables">
              <Input
                value={config.maxTicketBudgetUsd ?? ''}
                placeholder="none"
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setConfig({ ...config, maxTicketBudgetUsd: Number.isFinite(n) && n > 0 ? n : null });
                }}
              />
            </Field>
          </section>

          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight">Roles</h2>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">
                  Profile{current === null ? ' (custom mix):' : ':'}
                </span>
                {Object.keys(PROFILES).map((name) => (
                  <Button
                    key={name}
                    variant={current === name ? 'secondary' : 'outline'}
                    size="sm"
                    className="h-7 px-2 text-xs capitalize"
                    onClick={() => applyProfile(name)}
                  >
                    {current === name ? `● ${name}` : name}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {data.roles.map((role) => (
                <RoleCard
                  key={role}
                  role={role}
                  override={config.roles[role] ?? {}}
                  data={data}
                  models={models ?? []}
                  onChange={(next) => setConfig({ ...config, roles: { ...config.roles, [role]: next } })}
                />
              ))}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold tracking-tight">Opencode server</h2>
            <Field
              label="Server URL"
              hint="Used by the opencode-server runner. Blank lets em start and manage one; set a URL to attach to a server you run yourself (its environment must hold your provider keys)"
            >
              <Input
                value={config.opencodeServerUrl ?? ''}
                placeholder="managed by em"
                onChange={(e) => setConfig({ ...config, opencodeServerUrl: e.target.value.trim() || null })}
              />
            </Field>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold tracking-tight">Telemetry</h2>
            <Field
              label="OTLP endpoint"
              hint="OpenTelemetry collector base URL (spans go to <endpoint>/v1/traces). One trace per run, one span per agent. Blank disables; OTEL_EXPORTER_OTLP_ENDPOINT works as a fallback"
            >
              <Input
                value={config.otelEndpoint ?? ''}
                placeholder="http://localhost:4318"
                onChange={(e) => setConfig({ ...config, otelEndpoint: e.target.value.trim() || null })}
              />
            </Field>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold tracking-tight">MCP servers</h2>
            <p className="text-xs text-muted-foreground">
              JSON map of server name to spec: {'{"command", "args", "env"}'} for stdio, or {'{"type": "sse"|"http", "url", "headers"}'} for remote.
              Attach servers to roles in the role cards above; claude-sdk and claude-cli runners only.
            </p>
            <Textarea
              className="font-mono text-xs"
              rows={6}
              value={mcpText}
              onChange={(e) => setMcpText(e.target.value)}
            />
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold tracking-tight">Custom runners</h2>
            <p className="text-xs text-muted-foreground">
              JSON map of runner id to spec. Built-in runners (claude-cli, codex, gemini, opencode) need no entry.
            </p>
            <Textarea
              className="font-mono text-xs"
              rows={6}
              value={runnersText}
              onChange={(e) => setRunnersText(e.target.value)}
            />
          </section>

          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {message ? <span className="text-sm text-muted-foreground">{message}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
