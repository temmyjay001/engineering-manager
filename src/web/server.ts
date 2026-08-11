import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { run } from '../orchestrator/orchestrator';
import { openProject } from '../project';
import { registerProject } from '../registry';
import { registerActionRoutes } from './actions';
import { registerApiRoutes } from './api';
import { registerLiveRoutes } from './live';
import { ProjectManager } from './manager';
import { createRouter, type ApiRouter } from './router';
import { serveStatic } from './static';

const HEALTH_PATH = '/healthz';
const DEFAULT_PORT = 4788;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

export function createServer(manager: ProjectManager, router: ApiRouter): Server {
  return createHttpServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (method === 'GET' && path === HEALTH_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (path === '/api/projects' && method === 'GET') {
      sendJson(res, 200, { projects: manager.list() });
      return;
    }

    if (path.startsWith('/api/projects/')) {
      const parts = segments(path.slice('/api/projects/'.length));
      const id = parts[0];
      const ctx = id ? manager.ctxFor(id) : undefined;
      if (!ctx) {
        sendJson(res, 404, { error: 'unknown project' });
        return;
      }
      const rest = `/${parts.slice(1).join('/')}`;
      const handled = await router.handle(method, rest, req, res, ctx);
      if (!handled) sendJson(res, 404, { error: 'not found' });
      return;
    }

    if (path === '/api' || path.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    if (method === 'GET') {
      await serveStatic(res, path);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

function sweepAndMaybeResume(manager: ProjectManager): void {
  for (const entry of manager.list()) {
    const ctx = manager.ctxFor(entry.id);
    if (!ctx) continue;
    const swept = ctx.store.sweepDeadRuns();
    if (swept.length > 0) {
      console.log(`${entry.name}: swept ${swept.length} interrupted run${swept.length === 1 ? '' : 's'}`);
    }
    if (!ctx.project.config.autoResumeInterrupted) continue;
    for (const target of ctx.store.interruptedTargets()) {
      if (!target.startsWith('ticket:')) continue;
      const key = target.slice('ticket:'.length);
      const ticket = ctx.store.getTicketByKey(key);
      if (!ticket) continue;
      console.log(`${entry.name}: auto-resuming ${key}`);
      run(ctx, ticket.id, (line) => console.log(`[${entry.name}/${key}] ${line}`)).catch((err) => {
        console.error(`${entry.name}: failed to resume ${key}: ${(err as Error).message}`);
      });
    }
  }
}

export function startServer(portOverride?: number): Server {
  const configured = portOverride ?? Number(process.env.WEB_PORT);
  const port = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PORT;

  try {
    const project = openProject();
    registerProject(project.root);
  } catch {
    // No project in the current directory; serve whatever is already registered.
  }

  const manager = new ProjectManager();
  sweepAndMaybeResume(manager);
  const router = createRouter();
  registerApiRoutes(router);
  registerActionRoutes(router);
  registerLiveRoutes(router);
  const server = createServer(manager, router);
  server.listen(port, () => {
    const actual = (server.address() as AddressInfo).port;
    const count = manager.list().length;
    console.log(`em dashboard: ${count} project${count === 1 ? '' : 's'}`);
    console.log(`http://localhost:${actual}`);
  });
  return server;
}
