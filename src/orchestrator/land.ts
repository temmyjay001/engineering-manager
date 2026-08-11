import { execFileSync } from 'node:child_process';
import type { Ctx } from '../ctx';
import type { Store } from '../db/store';
import type { Ticket, TicketState } from '../domain/types';
import {
  advanceBase,
  clearPendingRef,
  createPullRequest,
  ensureWorktree,
  pushBranch,
  removeWorktree,
  resolveBase,
  setPendingRef,
  squashCandidate,
  syncWorktreeWithBase,
  worktreePath,
} from '../git/worktree';
import type { RunControl } from './cancel';

type Log = (msg: string) => void;
const noop: Log = () => {};

const LOCK_POLL_MS = 1000;
const MAX_BASE_RACES = 3;
const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;
const VERIFY_OUTPUT_LIMIT = 20_000;

export interface LandResult {
  status: TicketState;
  moved: boolean;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transition(store: Store, ticket: Ticket, to: TicketState, verdict: 'PASS' | 'FAIL' | null, note: string): void {
  store.transition({ ticketId: ticket.id, from: 'READY_TO_LAND', to, role: 'integration', verdict, note });
}

function parked(ticket: Ticket, message: string, log: Log): LandResult {
  log(`${ticket.key} not landed: ${message}`);
  return { status: 'READY_TO_LAND', moved: false, message };
}

function prBody(store: Store, ticket: Ticket): string {
  const criteria = store
    .getCriteria(ticket.id)
    .map((c) => `- [${c.met ? 'x' : ' '}] ${c.text}`)
    .join('\n');
  return [`Ticket ${ticket.key}: ${ticket.title}`, '', ticket.description, '', 'Acceptance criteria:', criteria].join(
    '\n',
  );
}

interface Verify {
  ok: boolean;
  output: string;
}

function runVerify(command: string, cwd: string): Verify {
  try {
    const out = execFileSync('sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      timeout: VERIFY_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const output = [e.stdout ?? '', e.stderr ?? ''].join('\n').trim() || e.message;
    return { ok: false, output };
  }
}

export async function landTicket(ctx: Ctx, ticketId: number, log: Log = noop, control?: RunControl): Promise<LandResult> {
  const { store, project } = ctx;
  const ticket = store.getTicketById(ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  if (ticket.status !== 'READY_TO_LAND') {
    return { status: ticket.status, moved: false, message: `${ticket.key} is ${ticket.status}, not READY_TO_LAND` };
  }

  const strategy = project.config.mergeStrategy;

  if (!ticket.branch) {
    transition(store, ticket, 'DONE', 'PASS', 'nothing to merge; no branch was created');
    log(`${ticket.key} READY_TO_LAND -> DONE [no branch]`);
    return { status: 'DONE', moved: true, message: 'done (no branch)' };
  }

  if (strategy === 'none') {
    transition(store, ticket, 'DONE', 'PASS', 'branch left in place (mergeStrategy: none)');
    log(`${ticket.key} READY_TO_LAND -> DONE [branch left in place]`);
    return { status: 'DONE', moved: true, message: 'done (branch left in place)' };
  }

  if (strategy === 'pr') {
    try {
      pushBranch(project, ticket.key);
      const url = createPullRequest(project, ticket.key, `${ticket.key}: ${ticket.title}`, prBody(store, ticket));
      removeWorktree(project, ticket.key, { deleteBranch: false });
      transition(store, ticket, 'DONE', 'PASS', `PR opened: ${url}`);
      log(`${ticket.key} READY_TO_LAND -> DONE [PR opened: ${url}]`);
      return { status: 'DONE', moved: true, message: `PR opened: ${url}` };
    } catch (err) {
      return parked(ticket, `PR creation failed: ${(err as Error).message}`, log);
    }
  }

  if (!ensureWorktree(project, ticket.key)) {
    return parked(ticket, `branch ${ticket.branch} has no worktree and one could not be recreated`, log);
  }

  // mergeStrategy: merge. All landings serialize on the integration lock so
  // exactly one ticket at a time syncs, verifies, and advances the base.
  let run = store.startRun('integration');
  while (!run) {
    if (control?.aborted()) return parked(ticket, 'landing cancelled while waiting for the integration lock', log);
    await sleep(LOCK_POLL_MS);
    run = store.startRun('integration');
  }
  const rlog: Log = (msg) => {
    store.appendRunLog(run!.id, msg);
    log(msg);
  };

  try {
    for (let race = 0; race < MAX_BASE_RACES; race++) {
      if (control?.aborted()) {
        clearPendingRef(project, ticket.key);
        store.finishRun(run.id, 'CANCELLED', 'cancelled by request');
        return parked(ticket, 'landing cancelled', rlog);
      }

      const base = resolveBase(project);
      if (!base) {
        store.finishRun(run.id, 'ERROR', 'no base branch');
        return parked(ticket, 'no base branch: set baseBranch in .em/config.json or check out a branch', rlog);
      }

      const sync = syncWorktreeWithBase(project, ticket.key, ticket.baseSha ?? base.sha);
      if (sync.conflicted) {
        const note = `merging ${base.ref} (${base.sha.slice(0, 7)}) into the worktree conflicts; resolve in the worktree, commit, then run em land ${ticket.key}`;
        transition(store, ticket, 'NEEDS_INTEGRATION', 'FAIL', note);
        store.finishRun(run.id, 'OK');
        rlog(`${ticket.key} READY_TO_LAND -> NEEDS_INTEGRATION [${note}]`);
        return { status: 'NEEDS_INTEGRATION', moved: true, message: note };
      }
      if (sync.updated) {
        store.setWorktree(ticket.id, ticket.branch, sync.baseSha);
        rlog(`${ticket.key} worktree synced with ${base.ref} ${sync.baseSha.slice(0, 7)}`);
      }

      const verifyCommand = project.config.verifyCommand;
      if (verifyCommand) {
        rlog(`${ticket.key} verifying merged tree: ${verifyCommand}`);
        const verify = runVerify(verifyCommand, worktreePath(project, ticket.key));
        if (!verify.ok) {
          const note = `verification failed on the merged tree; fix in the worktree, then run em land ${ticket.key}`;
          store.addArtifact(ticket.id, 'VERIFY', 'integration', verify.output.slice(-VERIFY_OUTPUT_LIMIT));
          transition(store, ticket, 'NEEDS_INTEGRATION', 'FAIL', note);
          store.finishRun(run.id, 'OK');
          rlog(`${ticket.key} READY_TO_LAND -> NEEDS_INTEGRATION [${note}]`);
          return { status: 'NEEDS_INTEGRATION', moved: true, message: note };
        }
      }

      const parent = sync.updated ? sync.baseSha : base.sha;
      const candidate = squashCandidate(project, ticket.key, parent, `${ticket.key}: ${ticket.title}`);
      setPendingRef(project, ticket.key, candidate);

      const advanced = advanceBase(project, base.ref, parent, candidate);
      if (advanced === 'ok') {
        store.setMergedSha(ticket.id, candidate);
        transition(store, ticket, 'DONE', 'PASS', `landed on ${base.ref} as ${candidate.slice(0, 7)}`);
        clearPendingRef(project, ticket.key);
        removeWorktree(project, ticket.key);
        store.finishRun(run.id, 'OK');
        rlog(`${ticket.key} READY_TO_LAND -> DONE [landed on ${base.ref} as ${candidate.slice(0, 7)}]`);
        return { status: 'DONE', moved: true, message: `landed as ${candidate.slice(0, 7)}` };
      }
      clearPendingRef(project, ticket.key);
      if (advanced === 'dirty') {
        store.finishRun(run.id, 'OK');
        return parked(ticket, `${base.ref} is checked out with uncommitted changes; commit or stash, then run em land ${ticket.key}`, rlog);
      }
      if (advanced === 'busy') {
        store.finishRun(run.id, 'OK');
        return parked(ticket, `${base.ref} is checked out in another worktree; free it, then run em land ${ticket.key}`, rlog);
      }
      rlog(`${ticket.key} base ${base.ref} moved during landing; re-syncing (attempt ${race + 1}/${MAX_BASE_RACES})`);
    }
    store.finishRun(run.id, 'OK');
    return parked(ticket, `base kept moving during landing; run em land ${ticket.key} again`, rlog);
  } catch (err) {
    clearPendingRef(project, ticket.key);
    store.finishRun(run.id, 'ERROR', (err as Error).message);
    return parked(ticket, `landing failed: ${(err as Error).message}`, log);
  }
}
