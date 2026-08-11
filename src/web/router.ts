import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from '../ctx';

export type ApiContext = Ctx;

export type ApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  params: Record<string, string>,
) => void | Promise<void>;

interface Route {
  method: string;
  segments: string[];
  handler: ApiHandler;
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

export class ApiRouter {
  private routes: Route[] = [];

  register(method: string, path: string, handler: ApiHandler): void {
    this.routes.push({ method: method.toUpperCase(), segments: segmentsOf(path), handler });
  }

  async handle(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
    ctx: ApiContext,
  ): Promise<boolean> {
    const requestMethod = method.toUpperCase();
    const requestSegments = segmentsOf(path);
    for (const route of this.routes) {
      if (route.method !== requestMethod) continue;
      if (route.segments.length !== requestSegments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const routeSegment = route.segments[i]!;
        const requestSegment = requestSegments[i]!;
        if (routeSegment.startsWith(':')) {
          params[routeSegment.slice(1)] = decodeURIComponent(requestSegment);
        } else if (routeSegment !== requestSegment) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      await route.handler(req, res, ctx, params);
      return true;
    }
    return false;
  }
}

export function createRouter(): ApiRouter {
  return new ApiRouter();
}
