import type { ServerResponse } from 'node:http';
import type { Store } from '../db/store';
import type { TicketState } from '../domain/types';
import type { ApiHandler, ApiRouter } from './router';

const CHANGE_POLL_MS = 1000;
const LOG_POLL_MS = 500;

function beginSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
}

function send(res: ServerResponse, event: Record<string, unknown>): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function pollUntilClosed(res: ServerResponse, intervalMs: number, tick: () => void): void {
  const timer = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(timer);
      return;
    }
    tick();
  }, intervalMs);
  res.on('close', () => clearInterval(timer));
}

function targetStatus(store: Store, kind: string, key: string): string | undefined {
  if (kind === 'tickets') return store.getTicketByKey(key)?.status;
  return store.getEpicByKey(key)?.status;
}

function isTerminalTicket(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_TICKET.has(status as TicketState);
}

const TERMINAL_TICKET = new Set<TicketState>(['DONE', 'BLOCKED']);

export function registerLiveRoutes(router: ApiRouter): void {
  router.register('GET', '/events', (_req, res, { store }) => {
    beginSse(res);
    let last = store.revision();
    send(res, { type: 'revision', value: last });
    pollUntilClosed(res, CHANGE_POLL_MS, () => {
      const current = store.revision();
      if (current !== last) {
        last = current;
        send(res, { type: 'change', value: current });
      }
    });
  });

  const logHandler = (kind: 'tickets' | 'epics'): ApiHandler => (_req, res, { store }, params) => {
    const key = params.key ?? '';
    const target = `${kind === 'tickets' ? 'ticket' : 'epic'}:${key}`;
    const run = store.latestRun(target);
    beginSse(res);
    if (!run) {
      send(res, { type: 'idle' });
      res.end();
      return;
    }

    let lastLogId = 0;
    const flush = () => {
      for (const entry of store.getRunLogs(run.id, lastLogId)) {
        lastLogId = entry.id;
        send(res, { type: 'log', line: entry.line });
      }
    };
    flush();

    const current = store.getRun(run.id);
    if (current && current.status !== 'RUNNING') {
      finish(res, store, kind, key, current.status, current.error);
      return;
    }

    pollUntilClosed(res, LOG_POLL_MS, () => {
      flush();
      const now = store.getRun(run.id);
      if (now && now.status !== 'RUNNING') {
        finish(res, store, kind, key, now.status, now.error);
      }
    });
  };

  router.register('GET', '/tickets/:key/log', logHandler('tickets'));
  router.register('GET', '/epics/:key/log', logHandler('epics'));
}

function finish(
  res: ServerResponse,
  store: Store,
  kind: 'tickets' | 'epics',
  key: string,
  runStatus: string,
  error: string | null,
): void {
  const status = targetStatus(store, kind, key);
  if (runStatus === 'ERROR' && error) {
    send(res, { type: 'error', message: error });
  } else {
    send(res, { type: 'done', status });
  }
  if (kind === 'tickets' && isTerminalTicket(status)) {
    send(res, { type: 'terminal' });
  }
  res.end();
}
