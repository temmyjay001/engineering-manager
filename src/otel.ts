import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export type AttrValue = string | number | boolean;

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, AttrValue>;
  error?: string;
}

export interface OtelTarget {
  endpoint: string;
  headers: Record<string, string>;
  resource: Record<string, AttrValue>;
}

export class RunTrace {
  readonly traceId = randomBytes(16).toString('hex');
  readonly rootSpanId = randomBytes(8).toString('hex');
  private readonly spans: SpanRecord[] = [];

  constructor(
    private readonly target: OtelTarget,
    private readonly rootName: string,
    private readonly rootAttributes: Record<string, AttrValue>,
    private readonly rootStartMs: number,
  ) {}

  addSpan(input: {
    name: string;
    startMs: number;
    endMs: number;
    attributes: Record<string, AttrValue>;
    error?: string;
  }): void {
    this.spans.push({
      traceId: this.traceId,
      spanId: randomBytes(8).toString('hex'),
      parentSpanId: this.rootSpanId,
      ...input,
    });
  }

  finish(extraRootAttributes: Record<string, AttrValue>, error?: string): SpanRecord[] {
    return [
      ...this.spans,
      {
        traceId: this.traceId,
        spanId: this.rootSpanId,
        name: this.rootName,
        startMs: this.rootStartMs,
        endMs: Date.now(),
        attributes: { ...this.rootAttributes, ...extraRootAttributes },
        error,
      },
    ];
  }

  get exportTarget(): OtelTarget {
    return this.target;
  }
}

const storage = new AsyncLocalStorage<RunTrace | undefined>();

export function currentRunTrace(): RunTrace | undefined {
  return storage.getStore();
}

export interface OtelConfigSource {
  root: string;
  config: { otelEndpoint: string | null; otelHeaders: Record<string, string> };
}

export function otelTargetFor(project: OtelConfigSource): OtelTarget | null {
  const endpoint = project.config.otelEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;
  if (!endpoint) return null;
  return {
    endpoint,
    headers: project.config.otelHeaders,
    resource: {
      'service.name': 'emorg',
      'em.project': project.root.split('/').filter(Boolean).at(-1) ?? project.root,
    },
  };
}

function toNano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function toAttribute(key: string, value: AttrValue): Record<string, unknown> {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

export function otlpPayload(resource: Record<string, AttrValue>, spans: SpanRecord[]): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: Object.entries(resource).map(([k, v]) => toAttribute(k, v)) },
        scopeSpans: [
          {
            scope: { name: 'emorg' },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: 1,
              startTimeUnixNano: toNano(span.startMs),
              endTimeUnixNano: toNano(span.endMs),
              attributes: Object.entries(span.attributes).map(([k, v]) => toAttribute(k, v)),
              status: span.error ? { code: 2, message: span.error.slice(0, 300) } : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

let exportFailureLogged = false;

export async function exportSpans(target: OtelTarget, spans: SpanRecord[]): Promise<void> {
  const url = `${target.endpoint.replace(/\/$/, '')}/v1/traces`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...target.headers },
      body: JSON.stringify(otlpPayload(target.resource, spans)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`collector responded ${res.status}`);
  } catch (err) {
    if (!exportFailureLogged) {
      exportFailureLogged = true;
      console.error(`otel: failed to export spans to ${url}: ${(err as Error).message} (further failures are silent)`);
    }
  }
}

export async function withRunTrace<T>(
  target: OtelTarget | null,
  rootName: string,
  rootAttributes: Record<string, AttrValue>,
  fn: () => Promise<T>,
  finalAttributes: (result: T | undefined) => Record<string, AttrValue> = () => ({}),
): Promise<T> {
  if (!target || storage.getStore()) return fn();
  const trace = new RunTrace(target, rootName, rootAttributes, Date.now());
  try {
    const result = await storage.run(trace, fn);
    void exportSpans(target, trace.finish(finalAttributes(result)));
    return result;
  } catch (err) {
    void exportSpans(target, trace.finish(finalAttributes(undefined), (err as Error).message));
    throw err;
  }
}
