import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentRunTrace, otelTargetFor, otlpPayload, withRunTrace, type OtelTarget } from '../src/otel';

describe('otlpPayload', () => {
  it('encodes spans, attribute types, and status', () => {
    const payload = otlpPayload({ 'service.name': 'emorg' }, [
      {
        traceId: 't1',
        spanId: 's1',
        name: 'em.run',
        startMs: 1000,
        endMs: 2000,
        attributes: { 'em.cost_usd': 1.5, 'em.num_turns': 3, 'em.target': 'ticket:EM-1', 'em.flag': true },
      },
      {
        traceId: 't1',
        spanId: 's2',
        parentSpanId: 's1',
        name: 'agent.pm',
        startMs: 1100,
        endMs: 1500,
        attributes: {},
        error: 'boom',
      },
    ]) as any;

    const scope = payload.resourceSpans[0];
    expect(scope.resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'emorg' } }]);
    const [root, child] = scope.scopeSpans[0].spans;
    expect(root).toMatchObject({
      traceId: 't1',
      name: 'em.run',
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '2000000000',
      status: { code: 1 },
    });
    expect(root.parentSpanId).toBeUndefined();
    expect(root.attributes).toContainEqual({ key: 'em.cost_usd', value: { doubleValue: 1.5 } });
    expect(root.attributes).toContainEqual({ key: 'em.num_turns', value: { intValue: '3' } });
    expect(root.attributes).toContainEqual({ key: 'em.flag', value: { boolValue: true } });
    expect(child).toMatchObject({ parentSpanId: 's1', status: { code: 2, message: 'boom' } });
  });
});

describe('otelTargetFor', () => {
  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it('is null with no endpoint anywhere', () => {
    expect(otelTargetFor({ root: '/x/proj', config: { otelEndpoint: null, otelHeaders: {} } })).toBeNull();
  });

  it('uses the config endpoint and derives the project resource', () => {
    const target = otelTargetFor({
      root: '/home/me/proj',
      config: { otelEndpoint: 'http://collector:4318', otelHeaders: { 'x-auth': 't' } },
    })!;
    expect(target.endpoint).toBe('http://collector:4318');
    expect(target.headers).toEqual({ 'x-auth': 't' });
    expect(target.resource).toMatchObject({ 'service.name': 'emorg', 'em.project': 'proj' });
  });

  it('falls back to OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env:4318';
    const target = otelTargetFor({ root: '/x/p', config: { otelEndpoint: null, otelHeaders: {} } });
    expect(target?.endpoint).toBe('http://env:4318');
  });
});

describe('withRunTrace', () => {
  let server: Server;
  let received: any[] = [];
  let endpoint = '';

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ url: req.url, json: JSON.parse(body) });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  const target = (): OtelTarget => ({ endpoint, headers: { 'x-test': '1' }, resource: { 'service.name': 'emorg' } });

  it('runs fn without a trace when disabled', async () => {
    const result = await withRunTrace(null, 'em.run', {}, async () => {
      expect(currentRunTrace()).toBeUndefined();
      return 42;
    });
    expect(result).toBe(42);
    expect(received).toHaveLength(0);
  });

  it('exports a root span plus children added during the run', async () => {
    const result = await withRunTrace(
      target(),
      'em.run',
      { 'em.target': 'ticket:EM-1' },
      async () => {
        currentRunTrace()!.addSpan({
          name: 'agent.pm',
          startMs: Date.now() - 50,
          endMs: Date.now(),
          attributes: { 'em.role': 'pm' },
        });
        return 'DONE';
      },
      (r) => ({ 'em.final_status': r ?? 'unknown' }),
    );
    expect(result).toBe('DONE');
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/v1/traces');
    const spans = received[0].json.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(2);
    const root = spans.find((s: any) => s.name === 'em.run');
    const child = spans.find((s: any) => s.name === 'agent.pm');
    expect(child.parentSpanId).toBe(root.spanId);
    expect(child.traceId).toBe(root.traceId);
    expect(root.attributes).toContainEqual({ key: 'em.final_status', value: { stringValue: 'DONE' } });
  });

  it('joins an existing trace instead of nesting new roots', async () => {
    await withRunTrace(target(), 'em.epic', {}, async () => {
      const outer = currentRunTrace();
      await withRunTrace(target(), 'em.run', {}, async () => {
        expect(currentRunTrace()).toBe(outer);
      });
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
  });

  it('marks the root span as errored when fn throws, and still exports', async () => {
    await expect(
      withRunTrace(target(), 'em.run', {}, async () => {
        throw new Error('exploded');
      }),
    ).rejects.toThrow('exploded');
    await new Promise((r) => setTimeout(r, 100));
    const spans = received[0].json.resourceSpans[0].scopeSpans[0].spans;
    expect(spans[0].status).toEqual({ code: 2, message: 'exploded' });
  });
});
