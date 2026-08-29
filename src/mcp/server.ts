import { createInterface } from 'node:readline';
import pkg from '../../package.json';
import { DEFAULT_MODEL, ROLE_MODELS } from '../config';
import type { Ctx } from '../ctx';
import { adviceFor } from '../domain/report';
import { firstBuildState } from '../domain/states';
import type { TicketState } from '../domain/types';
import { assertGitRepo } from '../git/worktree';
import { materializeEpic, performUnblock, planEpic, refreshEpicStatus, run, runEpic } from '../orchestrator/orchestrator';

const PROTOCOL_VERSION = '2025-06-18';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint: boolean };
}

const stringArg = (description: string) => ({ type: 'string', description });

function obj(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const INSTRUCTIONS = `em runs a ticket pipeline: create_ticket, then run_ticket, which drives the ticket to AWAIT_APPROVAL with acceptance criteria. Present those criteria to a human and wait for their explicit decision; approving a ticket is never done on the agent's own judgment. Once the human approves (approve_ticket) or gives feedback (reject_ticket), the pipeline continues automatically through development and review gates. Use status and show_ticket to check on work, and report for delivery and spend metrics.`;

const TOOLS: ToolDef[] = [
  {
    name: 'status',
    description: 'List every epic and ticket with statuses and costs. Start here to see the board.',
    inputSchema: obj({}, []),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_ticket',
    description:
      'Create a ticket from a request. The PM turns it into acceptance criteria on the next run. Returns the ticket key.',
    inputSchema: obj({ description: stringArg('The feature request or task, in plain language') }, ['description']),
  },
  {
    name: 'run_ticket',
    description:
      'Drive a ticket through the pipeline (PM, approval gate, architect, developer, review gates). Blocks until the ticket needs a human or finishes. Long-running.',
    inputSchema: obj({ key: stringArg('Ticket key, e.g. EM-1') }, ['key']),
  },
  {
    name: 'show_ticket',
    description: 'Full ticket detail: status, acceptance criteria, transition history, cost, and artifact kinds.',
    inputSchema: obj({ key: stringArg('Ticket key') }, ['key']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'approve_ticket',
    description:
      'Approve a ticket that is AWAIT_APPROVAL and continue the pipeline. Only call when the human has approved the criteria or explicitly delegated approval.',
    inputSchema: obj({ key: stringArg('Ticket key') }, ['key']),
  },
  {
    name: 'reject_ticket',
    description: 'Send an AWAIT_APPROVAL ticket back to the PM with feedback, then re-run it.',
    inputSchema: obj({ key: stringArg('Ticket key'), feedback: stringArg('What the PM should change') }, ['key', 'feedback']),
  },
  {
    name: 'unblock_ticket',
    description: 'Send a BLOCKED ticket back to work with guidance, then continue the pipeline.',
    inputSchema: obj({ key: stringArg('Ticket key'), guidance: stringArg('Direction for the role that resumes the ticket') }, ['key', 'guidance']),
  },
  {
    name: 'create_epic',
    description: 'Create an epic from a large goal. The planner decomposes it into subtickets when planned.',
    inputSchema: obj({ goal: stringArg('The overall goal') }, ['goal']),
  },
  {
    name: 'plan_epic',
    description: 'Run the planner on an epic: proposes subtickets with dependencies and awaits plan approval.',
    inputSchema: obj({ key: stringArg('Epic key, e.g. EP-1') }, ['key']),
  },
  {
    name: 'approve_epic',
    description: 'Approve an epic plan: creates the subtickets. Follow with run_epic to build them.',
    inputSchema: obj({ key: stringArg('Epic key') }, ['key']),
  },
  {
    name: 'run_epic',
    description: 'Build an epic: runs subtickets through the pipeline, independent ones in parallel. Long-running.',
    inputSchema: obj({ key: stringArg('Epic key') }, ['key']),
  },
  {
    name: 'report',
    description: 'Delivery, quality-gate, spend, and run metrics over a window, with cost advice.',
    inputSchema: obj({ days: { type: 'number', description: 'Window in days; omit for 30, use 0 for all time' } }, []),
    annotations: { readOnlyHint: true },
  },
];

export class EmMcpServer {
  constructor(
    private readonly ctx: Ctx,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  get tools(): ToolDef[] {
    return TOOLS;
  }

  async handleLine(line: string): Promise<object | null> {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return null;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    }
    return this.handle(message);
  }

  async handle(message: any): Promise<object | null> {
    if (message.method === 'notifications/initialized' || message.id === undefined) return null;
    try {
      const result = await this.dispatch(message.method, message.params ?? {});
      return { jsonrpc: '2.0', id: message.id, result };
    } catch (err) {
      if (err instanceof ToolError) {
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: err.message }], isError: true },
        };
      }
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: err instanceof MethodNotFound ? -32601 : -32603, message: (err as Error).message },
      };
    }
  }

  private async dispatch(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'emorg', version: pkg.version },
          instructions: INSTRUCTIONS,
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const text = await this.callTool(String(params.name), params.arguments ?? {});
        return { content: [{ type: 'text', text }], isError: false };
      }
      default:
        throw new MethodNotFound(`method not supported: ${method}`);
    }
  }

  private async callTool(name: string, args: Record<string, any>): Promise<string> {
    const { store, project } = this.ctx;
    try {
      switch (name) {
        case 'status': {
          const epics = store.listEpics().map((e) => ({ ...e, subtickets: store.getSubtickets(e.id).map((t) => t.key) }));
          const tickets = store.listTickets().map((t) => ({
            key: t.key,
            title: t.title || t.description.slice(0, 50),
            status: t.status,
            epicId: t.epicId,
            costUsd: store.ticketCostUsd(t.id),
          }));
          return JSON.stringify({ epics, tickets }, null, 1);
        }
        case 'create_ticket': {
          const description = String(args.description ?? '').trim();
          if (!description) throw new ToolError('description is required');
          const t = store.createTicket({ title: '', description });
          return `Created ${t.key} (BACKLOG). Call run_ticket to have the PM draft acceptance criteria.`;
        }
        case 'run_ticket': {
          assertGitRepo(project);
          const t = this.ticket(args.key);
          const final = await run(this.ctx, t.id, this.log);
          if (final.epicId) refreshEpicStatus(store, final.epicId, this.log);
          return this.ticketSummary(final.key);
        }
        case 'show_ticket':
          return this.ticketSummary(this.ticket(args.key).key);
        case 'approve_ticket': {
          const t = this.ticket(args.key);
          if (t.status !== 'AWAIT_APPROVAL') throw new ToolError(`${t.key} is ${t.status}, not awaiting approval`);
          store.transition({
            ticketId: t.id,
            from: t.status,
            to: firstBuildState(project.config.pipeline),
            role: null,
            verdict: 'PASS',
            note: 'approved (via MCP)',
          });
          assertGitRepo(project);
          const final = await run(this.ctx, t.id, this.log);
          return this.ticketSummary(final.key);
        }
        case 'reject_ticket': {
          const t = this.ticket(args.key);
          if (t.status !== 'AWAIT_APPROVAL') throw new ToolError(`${t.key} is ${t.status}, not awaiting approval`);
          const feedback = String(args.feedback ?? '').trim();
          if (!feedback) throw new ToolError('feedback is required');
          store.setFeedback(t.id, feedback);
          store.transition({ ticketId: t.id, from: t.status, to: 'BACKLOG', role: null, verdict: 'FAIL', note: feedback });
          const final = await run(this.ctx, t.id, this.log);
          return this.ticketSummary(final.key);
        }
        case 'unblock_ticket': {
          const t = this.ticket(args.key);
          if (t.status !== 'BLOCKED') throw new ToolError(`${t.key} is ${t.status}, not blocked`);
          const guidance = String(args.guidance ?? '').trim();
          if (!guidance) throw new ToolError('guidance is required');
          performUnblock(this.ctx, t, guidance);
          assertGitRepo(project);
          const final = await run(this.ctx, t.id, this.log);
          return this.ticketSummary(final.key);
        }
        case 'create_epic': {
          const goal = String(args.goal ?? '').trim();
          if (!goal) throw new ToolError('goal is required');
          const e = store.createEpic({ title: goal.slice(0, 80), description: goal });
          return `Created ${e.key} (PLANNING). Call plan_epic to decompose it.`;
        }
        case 'plan_epic': {
          const e = this.epic(args.key);
          const final = await planEpic(this.ctx, e.id, this.log);
          return `${final.key}: ${final.status}\n${final.plan ?? ''}`.trim();
        }
        case 'approve_epic': {
          const e = this.epic(args.key);
          const subs = materializeEpic(store, e.id);
          return `${e.key}: ${subs.length} subtickets created (${subs.map((s) => s.key).join(', ')}). Call run_epic to build.`;
        }
        case 'run_epic': {
          assertGitRepo(project);
          const e = this.epic(args.key);
          const final = await runEpic(this.ctx, e.id, this.log);
          const subs = store.getSubtickets(final.id).map((s) => `${s.key}: ${s.status}`);
          return `${final.key}: ${final.status}\n${subs.join('\n')}`;
        }
        case 'report': {
          const days = typeof args.days === 'number' && args.days > 0 ? Math.round(args.days) : args.days === 0 ? null : 30;
          const report = store.buildReport(days, project.config.monthlyBudgetUsd);
          const roleModels = Object.fromEntries(
            Object.entries(project.config.roles).map(([role, o]) => [
              role,
              o.model ?? (ROLE_MODELS as Record<string, string>)[role],
            ]),
          );
          return JSON.stringify({ ...report, advice: adviceFor(report, roleModels, DEFAULT_MODEL) }, null, 1);
        }
        default:
          throw new ToolError(`unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError((err as Error).message);
    }
  }

  private ticket(key: unknown) {
    const t = this.ctx.store.getTicketByKey(String(key ?? ''));
    if (!t) throw new ToolError(`no ticket ${key}`);
    return t;
  }

  private epic(key: unknown) {
    const e = this.ctx.store.getEpicByKey(String(key ?? ''));
    if (!e) throw new ToolError(`no epic ${key}`);
    return e;
  }

  private ticketSummary(key: string): string {
    const { store } = this.ctx;
    const t = store.getTicketByKey(key)!;
    const criteria = store.getCriteria(t.id).map((c) => `${c.met ? '[x]' : '[ ]'} ${c.text}`);
    const artifacts = [...new Set(store.getArtifacts(t.id).map((a) => a.kind))];
    const transitions = store.listTransitions(t.id).slice(-5).map((tr) => `${tr.fromState} -> ${tr.toState} ${tr.note ?? ''}`.trim());
    return JSON.stringify(
      {
        key: t.key,
        title: t.title,
        status: t.status,
        gate: t.gate,
        feedback: t.feedback,
        costUsd: store.ticketCostUsd(t.id),
        criteria,
        artifacts,
        recentTransitions: transitions,
      },
      null,
      1,
    );
  }
}

class ToolError extends Error {}
class MethodNotFound extends Error {}

export async function serveMcpStdio(ctx: Ctx): Promise<void> {
  const server = new EmMcpServer(ctx, (line) => process.stderr.write(`${line}\n`));
  const rl = createInterface({ input: process.stdin });
  await new Promise<void>((resolvePromise) => {
    rl.on('line', (line) => {
      void server.handleLine(line).then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
    });
    rl.on('close', () => resolvePromise());
  });
}
