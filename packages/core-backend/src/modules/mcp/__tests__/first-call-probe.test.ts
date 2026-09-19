import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import net from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { closeMountedRoutes, mountMcpRoutes } from './mcp-routes-harness.js';
import {
  formatProbeReport,
  probeFirstCall,
  readSessionId,
  summarizeProbe,
  timingsOf,
  type FirstCallAttempt,
} from '../first-call-probe.js';

/**
 * The reproduction probe itself (`first-call-probe.ts`).
 *
 * The ticket's question is whether a fresh connection's FIRST `start_session`
 * can fail on our side, and the probe is the instrument that answers it. An
 * instrument that quietly scored a failure as a success, or that lost the
 * other forty-nine results the moment one attempt threw, would answer it
 * wrongly and look convincing doing so — so what is pinned here is that the
 * probe opens one connection per attempt, calls once and never retries,
 * records the PLATFORM's own error text, and survives every failure shape the
 * surface can produce.
 *
 * The stand-in behind `/api/mcp` is a real SDK `Server` on the real stateless
 * route, so the probe is measured against a real Streamable-HTTP handshake.
 * What it is NOT measured against here is the UTCP proxy — `mcp.e2e.test.ts`
 * runs the same probe against the full platform for that.
 */

const BEARER = 'bevel_probe_key';

/** Tool answer as the KB surface sends it: the tool's JSON in one text block. */
const sessionBlock = () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: randomUUID() }) }] });

interface StandInOptions {
  /** Return a message to fail the nth (1-based) call with a thrown McpError. */
  failWith?: (call: number) => string | undefined;
  /** Return a message to answer the nth call with an `isError` RESULT instead. */
  isErrorWith?: (call: number) => string | undefined;
  /** Answer every call with this instead of a session id (the "200, no id" case). */
  answerWith?: () => { content: Array<{ type: 'text'; text: string }> };
  /** Hold each call open this long, so overlapping attempts are observable. */
  holdMs?: number;
}

/** A stand-in `McpService` whose every request server exposes `start_session`. */
function makeMcpService(opts: StandInOptions = {}) {
  let calls = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const createRequestServer = async (): Promise<Server> => {
    const server = new Server({ name: 'stub', version: '0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'start_session', inputSchema: { type: 'object' as const } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      const call = ++calls;
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        if (opts.holdMs) await new Promise((r) => setTimeout(r, opts.holdMs));
        const thrown = opts.failWith?.(call);
        if (thrown) throw new McpError(ErrorCode.InternalError, thrown);
        const returned = opts.isErrorWith?.(call);
        if (returned) return { isError: true, content: [{ type: 'text' as const, text: returned }] };
        return opts.answerWith?.() ?? sessionBlock();
      } finally {
        inFlight--;
      }
    });
    return server;
  };
  return { createRequestServer, calls: () => calls, peakInFlight: () => peakInFlight };
}

/** The `'tool'` mode target: the tool route on its own, no MCP transport. */
const toolApps: HttpServer[] = [];
async function startToolApp(handler: express.RequestHandler): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post('/api/agent/tools/start_session', handler);
  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  toolApps.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/**
 * A target that ACCEPTS the connection and then never answers.
 *
 * Not the same thing as a closed port: `http://127.0.0.1:1` refuses the TCP
 * connect immediately, so the probe's timeout never runs. This one completes
 * the handshake at the socket level and holds the request open forever, which
 * is the "never answers" a hung deployment produces and the only way the
 * timeout branch in `mcpAttempt`'s connect is exercised at all.
 */
const silentServers: net.Server[] = [];
const heldSockets: net.Socket[] = [];
async function startSilentServer(): Promise<string> {
  const server = net.createServer((socket) => {
    heldSockets.push(socket);
    socket.on('error', () => {});
    // Read the request and write nothing back.
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  silentServers.push(server);
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

afterEach(async () => {
  await closeMountedRoutes();
  await Promise.all(toolApps.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  // Sockets first: a server with a held-open connection never finishes closing.
  heldSockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(silentServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('probeFirstCall — fresh connections, one first call each', () => {
  it('fifty fresh connections in one burst each get a session id of their own', async () => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });

    const report = await probeFirstCall({ baseUrl, bearer: BEARER, connections: 50 });

    expect(report.ok).toBe(50);
    expect(report.failed).toBe(0);
    // Fifty connections, fifty ids, none shared: the burst is not one session
    // handed out repeatedly.
    expect(report.distinctSessionIds).toBe(50);
    // Exactly one call per connection — the probe never retries, which is the
    // whole point of it: a retry would paper over the failure being hunted.
    expect(mcpService.calls()).toBe(50);
    expect(report.attempts).toHaveLength(50);
    expect(report.connect.p50).toBeGreaterThan(0);
  });

  it('runs the burst concurrently by default, and respects a concurrency cap', async () => {
    const burst = makeMcpService({ holdMs: 20 });
    const burstUrl = await mountMcpRoutes({ mcpService: burst });
    await probeFirstCall({ baseUrl: burstUrl, bearer: BEARER, connections: 6 });
    expect(burst.peakInFlight()).toBeGreaterThan(1);

    const serial = makeMcpService({ holdMs: 5 });
    const serialUrl = await mountMcpRoutes({ mcpService: serial });
    const report = await probeFirstCall({ baseUrl: serialUrl, bearer: BEARER, connections: 6, concurrency: 1 });
    expect(serial.peakInFlight()).toBe(1);
    expect(report.ok).toBe(6);
  });

  it("records the platform's own error text for a failed call, and keeps the surviving results", async () => {
    // Every fifth call fails: a probe that threw on the first failure would
    // lose the other results, which are the evidence the ticket is after.
    const mcpService = makeMcpService({ failWith: (call) => (call % 5 === 0 ? 'session sink unavailable' : undefined) });
    const baseUrl = await mountMcpRoutes({ mcpService });

    const report = await probeFirstCall({ baseUrl, bearer: BEARER, connections: 10 });

    expect(report.failed).toBe(2);
    expect(report.ok).toBe(8);
    expect(report.distinctSessionIds).toBe(8);
    for (const failure of report.failures) {
      expect(failure.stage).toBe('call');
      expect(failure.error).toContain('session sink unavailable');
    }
  });

  it('counts an isError result as a failure rather than a success', async () => {
    const mcpService = makeMcpService({ isErrorWith: () => 'start_session refused: not an external caller' });
    const baseUrl = await mountMcpRoutes({ mcpService });

    const report = await probeFirstCall({ baseUrl, bearer: BEARER, connections: 3 });

    expect(report.ok).toBe(0);
    expect(report.failed).toBe(3);
    expect(report.failures[0]!.error).toContain('not an external caller');
  });

  it('counts an answer that carries no sessionId as a failure at the parse stage', async () => {
    const mcpService = makeMcpService({ answerWith: () => ({ content: [{ type: 'text' as const, text: 'ok' }] }) });
    const baseUrl = await mountMcpRoutes({ mcpService });

    const report = await probeFirstCall({ baseUrl, bearer: BEARER, connections: 2 });

    expect(report.failed).toBe(2);
    expect(report.failures.map((f) => f.stage)).toEqual(['parse', 'parse']);
  });

  it('records a REFUSED connection as a failure at the connect stage', async () => {
    // Nothing listens on this port, so the TCP connect is refused outright:
    // the handshake fails, which is the one stage a `call`-only probe would
    // never attribute correctly. This is the fast failure, not the hang — see
    // the next test for that.
    const report = await probeFirstCall({ baseUrl: 'http://127.0.0.1:1', bearer: BEARER, connections: 2, timeoutMs: 2_000 });

    expect(report.ok).toBe(0);
    expect(report.failures.map((f) => f.stage)).toEqual(['connect', 'connect']);
    expect(report.failures[0]!.error).toBeTruthy();
  });

  it('gives up on a connection that is accepted and then never answered', async () => {
    // The hang the ticket is actually about: the endpoint is up, the socket is
    // open, and nothing ever comes back. Without the per-request ceiling the
    // probe would sit here forever and report nothing at all, so what is pinned
    // is that the ceiling fires, the attempt is RECORDED as a connect-stage
    // failure with the platform's own wording, and the burst still settles.
    const baseUrl = await startSilentServer();
    const startedAt = Date.now();

    const report = await probeFirstCall({ baseUrl, bearer: BEARER, connections: 2, timeoutMs: 1_000 });

    expect(report.ok).toBe(0);
    expect(report.failed).toBe(2);
    expect(report.failures.map((f) => f.stage)).toEqual(['connect', 'connect']);
    expect(report.failures[0]!.error).toMatch(/timed out|timeout/i);
    // It waited for the ceiling rather than failing fast, and it did not wait
    // appreciably longer: a ceiling that never fires is the bug being excluded.
    expect(report.failures[0]!.connectMs).toBeGreaterThanOrEqual(900);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);

  it('refuses a count that is not a positive integer, before opening anything', async () => {
    const url = 'http://127.0.0.1:1';
    await expect(probeFirstCall({ baseUrl: url, bearer: BEARER, connections: 0 })).rejects.toThrow(/positive integer/);
    // `runPooled` clamps its limit with `Math.max(1, …)`, so an unchecked zero
    // would silently run one attempt at a time and report it as the burst.
    await expect(probeFirstCall({ baseUrl: url, bearer: BEARER, concurrency: 0 })).rejects.toThrow(
      /concurrency must be a positive integer/,
    );
    await expect(probeFirstCall({ baseUrl: url, bearer: BEARER, concurrency: -5 })).rejects.toThrow(/positive integer/);
    await expect(probeFirstCall({ baseUrl: url, bearer: BEARER, timeoutMs: 0 })).rejects.toThrow(
      /timeoutMs must be a positive integer/,
    );
  });

  it('refuses a base URL it cannot probe, instead of losing the whole burst to one throw', async () => {
    // `new URL()` throws synchronously inside the pool worker. Unchecked, that
    // rejects the `Promise.all` and takes all fifty results with it — the one
    // thing this probe promises never to do — so it is caught before the burst.
    for (const bad of ['', 'not-a-url', '/api/mcp', 'ftp://example.com']) {
      await expect(probeFirstCall({ baseUrl: bad, bearer: BEARER, connections: 50 })).rejects.toThrow(/baseUrl must be/);
    }
  });
});

describe("probeFirstCall in 'tool' mode — the same call with the transport removed", () => {
  it('posts straight to the tool route and reports no handshake time', async () => {
    const baseUrl = await startToolApp((_req, res) => {
      res.json({ sessionId: randomUUID() });
    });

    const report = await probeFirstCall({ baseUrl, bearer: BEARER, connections: 5, mode: 'tool' });

    expect(report.ok).toBe(5);
    expect(report.distinctSessionIds).toBe(5);
    // No transport, so no handshake to charge anyone for.
    expect(report.attempts.every((a) => a.connectMs === 0)).toBe(true);
  });

  it('records the status and body of a route that refuses', async () => {
    const baseUrl = await startToolApp((_req, res) => {
      res.status(403).json({ error: 'external callers only' });
    });

    const report = await probeFirstCall({ baseUrl, bearer: BEARER, connections: 2, mode: 'tool' });

    expect(report.failed).toBe(2);
    expect(report.failures[0]!.error).toContain('HTTP 403');
    expect(report.failures[0]!.error).toContain('external callers only');
  });

  it('sends the bearer the caller gave it', async () => {
    const seen: string[] = [];
    const baseUrl = await startToolApp((req, res) => {
      seen.push(req.headers.authorization ?? '');
      res.json({ sessionId: randomUUID() });
    });

    await probeFirstCall({ baseUrl, bearer: BEARER, connections: 2, mode: 'tool' });

    expect(seen).toEqual([`Bearer ${BEARER}`, `Bearer ${BEARER}`]);
  });

  it('strips a trailing slash from the base url, so the path is never doubled', async () => {
    const paths: string[] = [];
    const baseUrl = await startToolApp((req, res) => {
      paths.push(req.originalUrl);
      res.json({ sessionId: randomUUID() });
    });

    await probeFirstCall({ baseUrl: `${baseUrl}/`, bearer: BEARER, connections: 1, mode: 'tool' });

    expect(paths).toEqual(['/api/agent/tools/start_session']);
  });
});

describe('the report', () => {
  const attempt = (over: Partial<FirstCallAttempt>): FirstCallAttempt => ({
    index: 0,
    ok: true,
    connectMs: 10,
    callMs: 5,
    totalMs: 15,
    sessionId: 's',
    ...over,
  });

  it('takes percentiles by nearest rank, and answers zeros for an empty series', () => {
    expect(timingsOf([])).toEqual({ min: 0, p50: 0, p95: 0, max: 0 });
    // Ten samples: p50 is the 5th, p95 the 10th — the smallest sample with at
    // least that share of the series at or below it.
    expect(timingsOf([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).toEqual({ min: 1, p50: 5, p95: 10, max: 10 });
  });

  it('summarizes only the successful attempts, so a failure does not skew the timings', () => {
    const report = summarizeProbe(
      [
        attempt({ index: 0, totalMs: 10, callMs: 10, connectMs: 1, sessionId: 'a' }),
        attempt({ index: 1, totalMs: 20, callMs: 20, connectMs: 1, sessionId: 'b' }),
        attempt({ index: 2, ok: false, totalMs: 30_000, callMs: 30_000, sessionId: undefined, stage: 'call', error: 'boom' }),
      ],
      { target: 'http://x', mode: 'mcp', toolName: 'start_session', wallClockMs: 42 },
    );

    expect(report.connections).toBe(3);
    expect(report.ok).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.call.max).toBe(20);
    expect(report.distinctSessionIds).toBe(2);
    expect(report.failures.map((f) => f.index)).toEqual([2]);
  });

  it('counts two connections handed the SAME id as one distinct id', () => {
    const report = summarizeProbe([attempt({ index: 0, sessionId: 'same' }), attempt({ index: 1, sessionId: 'same' })], {
      target: 'http://x',
      mode: 'mcp',
      toolName: 'start_session',
      wallClockMs: 1,
    });
    expect(report.ok).toBe(2);
    expect(report.distinctSessionIds).toBe(1);
  });

  it('says in as many words when nothing failed, and spells out each failure when something did', () => {
    const clean = formatProbeReport(
      summarizeProbe([attempt({})], { target: 'http://x', mode: 'mcp', toolName: 'start_session', wallClockMs: 1 }),
    );
    expect(clean).toContain('1/1 succeeded');
    expect(clean).toContain('no failure reproduced');

    const dirty = formatProbeReport(
      summarizeProbe([attempt({ index: 3, ok: false, sessionId: undefined, stage: 'connect', error: 'socket hang up' })], {
        target: 'http://x',
        mode: 'mcp',
        toolName: 'start_session',
        wallClockMs: 1,
      }),
    );
    expect(dirty).toContain('FAILED #3 at connect');
    expect(dirty).toContain('socket hang up');
    expect(dirty).not.toContain('no failure reproduced');
  });

  it('escapes the error text, the target and the tool name, so a report cannot forge its own lines', () => {
    // All three are attacker- or typo-supplied: the error is whatever a remote
    // endpoint chose to send back, the target and tool name are whatever was
    // typed on the command line. A newline in any of them would otherwise add
    // a line to an operator's log that the platform never said, and an ANSI
    // escape would restyle the lines around it.
    const forged = formatProbeReport(
      summarizeProbe(
        [attempt({ index: 0, ok: false, sessionId: undefined, stage: 'call', error: 'boom\n  50/50 succeeded, 0 failed\u001b[31m' })],
        { target: 'http://x\nFAKE', mode: 'mcp', toolName: 'start_session\u0007', wallClockMs: 1 },
      ),
    );

    // One line per report line: nothing injected a line of its own.
    expect(forged.split('\n')).toHaveLength(6);
    expect(forged).not.toContain('\u001b');
    expect(forged).not.toContain('\u0007');
    // Escaped, not dropped — the operator still sees exactly what was sent.
    expect(forged).toContain('boom\\n');
    expect(forged).toContain('\\u001b[31m');
    expect(forged).toContain('http://x\\nFAKE');
  });
});

describe('readSessionId', () => {
  it('reads the id from structuredContent when the server sends one', () => {
    expect(readSessionId({ structuredContent: { sessionId: 'from-structured' }, content: [] })).toBe('from-structured');
  });

  it('reads the id out of a JSON text block, which is what the KB surface sends', () => {
    expect(readSessionId({ content: [{ type: 'text', text: '{"sessionId":"from-text"}' }] })).toBe('from-text');
  });

  it('skips a non-JSON block rather than throwing, and keeps reading the rest', () => {
    expect(
      readSessionId({ content: [{ type: 'text', text: 'heads up' }, { type: 'text', text: '{"sessionId":"later"}' }] }),
    ).toBe('later');
  });

  it('returns undefined when there is no id to find', () => {
    expect(readSessionId({ content: [{ type: 'text', text: '{"other":1}' }] })).toBeUndefined();
    expect(readSessionId(undefined)).toBeUndefined();
  });
});
