import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { printable } from '../../shared/printable.js';

/**
 * The reproduction probe behind "the first `start_session` on a fresh
 * connection failed; the immediate retry worked".
 *
 * The report that opened the ticket carried a generic error tagged `req_011…`
 * — the Anthropic API's request-id shape, which nothing on this side mints —
 * so the failure was most likely raised between the model and the tool rather
 * than by the tool. That was a hypothesis, and a hypothesis is not evidence:
 * this probe is how the platform side gets measured instead of assumed.
 *
 * What it reproduces, deliberately:
 *   - FRESH connections, not one connection reused. Each attempt builds its own
 *     `Client` and its own Streamable-HTTP transport, so each one pays for its
 *     own `initialize` before the call — the exact shape of the report.
 *   - The FIRST call on each, and only the first. A retry would hide the very
 *     failure being hunted.
 *   - All of them AT ONCE by default, because a busy agent tester opens
 *     connections in bursts and a first-call failure that only shows under
 *     contention would never appear one connection at a time.
 *
 * Two modes, because the answer the ticket needs is *where* a failure lives:
 *   - `'mcp'` (default) — the whole client path: transport handshake, then one
 *     `tools/call`. This is what the tester's client does.
 *   - `'tool'` — one plain POST to the tool route, no MCP transport at all.
 *     If `'mcp'` fails where `'tool'` does not, the fault is in the transport
 *     or in front of it; if both fail, it is the handler.
 *
 * The probe never retries: it records. Timings and every failure's own error
 * text land in the report, so what goes into the ticket log is the platform's
 * own message rather than a client-side id.
 */

/** Which path to the tool a single attempt takes. See the module comment. */
export type ProbeMode = 'mcp' | 'tool';

/** Where an attempt died. `parse` means the call answered but carried no id. */
export type ProbeStage = 'connect' | 'call' | 'parse';

/** One fresh connection's one first call. */
export interface FirstCallAttempt {
  /** 0-based position in the burst, so a failure can be located in the log. */
  index: number;
  ok: boolean;
  /** Handshake time. Always 0 in `'tool'` mode, which has no handshake. */
  connectMs: number;
  /** The `start_session` call itself, measured from after the handshake. */
  callMs: number;
  /** Connection open → id in hand (or failure): what the caller actually waits. */
  totalMs: number;
  /** The minted id, on success. */
  sessionId?: string;
  /** Set only on failure. */
  stage?: ProbeStage;
  /** The error exactly as the platform (or the transport) worded it. */
  error?: string;
}

/** Nearest-rank summary of one timing series, in milliseconds. */
export interface ProbeTimings {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

export interface FirstCallProbeReport {
  /** The endpoint probed, as given — this is what names the run in the log. */
  target: string;
  mode: ProbeMode;
  toolName: string;
  connections: number;
  ok: number;
  failed: number;
  /**
   * Distinct ids across the successful attempts. Anything below `ok` means two
   * fresh connections were handed the same session id — a far worse bug than
   * the one being hunted, so it is counted even though nobody expects it.
   */
  distinctSessionIds: number;
  /** How long the whole burst took, start to last attempt settled. */
  wallClockMs: number;
  /**
   * Timings over the SUCCESSFUL attempts only: a failure's elapsed time
   * measures how long the failure took, which would distort the percentiles
   * of the healthy path. Each failure carries its own timings in `failures`.
   */
  connect: ProbeTimings;
  call: ProbeTimings;
  total: ProbeTimings;
  /** Every failed attempt, with its stage and the error text as received. */
  failures: FirstCallAttempt[];
  /** Every attempt in burst order, successes included. */
  attempts: FirstCallAttempt[];
}

export interface FirstCallProbeOptions {
  /** Deployment root, e.g. `https://core-staging.bevel.software` (no `/api`). */
  baseUrl: string;
  /** A connection key (`bevel_…`) or another bearer the MCP surface accepts. */
  bearer: string;
  /** Fresh connections to open. The ticket's number is fifty. */
  connections?: number;
  /** Cap on attempts in flight. Defaults to `connections`: one single burst. */
  concurrency?: number;
  mode?: ProbeMode;
  /** Overridable only so a test can point the probe at a stand-in tool. */
  toolName?: string;
  /** Per-request ceiling, so a hung connection is a recorded failure. */
  timeoutMs?: number;
  /** Injectable clock (milliseconds), for tests that assert on timings. */
  now?: () => number;
}

const DEFAULT_CONNECTIONS = 50;
const DEFAULT_TIMEOUT_MS = 30_000;

/** The platform's own wording, whatever was thrown. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Nearest-rank percentiles: the smallest sample with at least p% of samples at
 * or below it. Same convention as the MCP latency measurement in
 * `mcp.e2e.test.ts`, so numbers from the two are comparable. An empty series
 * (every attempt failed) reports zeros rather than NaN — a log full of NaN
 * hides the failure list underneath it.
 */
export function timingsOf(samples: readonly number[]): ProbeTimings {
  if (samples.length === 0) return { min: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!;
  return { min: sorted[0]!, p50: pct(0.5), p95: pct(0.95), max: sorted[sorted.length - 1]! };
}

/**
 * Turn a settled burst into the report. Pure: `probeFirstCall` runs the
 * attempts, this decides what they mean, and the two are separable so the
 * arithmetic can be tested without opening a socket.
 */
export function summarizeProbe(
  attempts: readonly FirstCallAttempt[],
  meta: { target: string; mode: ProbeMode; toolName: string; wallClockMs: number },
): FirstCallProbeReport {
  const ok = attempts.filter((a) => a.ok);
  const failures = attempts.filter((a) => !a.ok);
  return {
    ...meta,
    connections: attempts.length,
    ok: ok.length,
    failed: failures.length,
    distinctSessionIds: new Set(ok.map((a) => a.sessionId)).size,
    connect: timingsOf(ok.map((a) => a.connectMs)),
    call: timingsOf(ok.map((a) => a.callMs)),
    total: timingsOf(ok.map((a) => a.totalMs)),
    failures,
    attempts: [...attempts],
  };
}

/** `41.2ms` — one decimal is the resolution the numbers actually carry. */
const ms = (n: number): string => `${n.toFixed(1)}ms`;
const line = (label: string, t: ProbeTimings): string =>
  `  ${label.padEnd(8)} p50 ${ms(t.p50)}  p95 ${ms(t.p95)}  min ${ms(t.min)}  max ${ms(t.max)}`;

/**
 * The report as the block that goes into the ticket log: the counts, the
 * timings, and then every failure spelled out with the stage it died at and
 * the error as the platform worded it. A run with no failures says so in as
 * many words — "no failure reproduced" is this ticket's most likely finding
 * and it has to be as legible as a failure would be.
 *
 * Every value that did not come from this file goes through `printable`: the
 * error text is whatever a remote endpoint chose to send, and the target and
 * tool name are whatever the operator typed. A newline or an ANSI escape in
 * any of them would otherwise forge or restyle the lines around it, in the one
 * output a reader trusts to say what the platform actually did.
 */
export function formatProbeReport(report: FirstCallProbeReport): string {
  const lines = [
    `${report.connections} fresh connections, one first ${printable(report.toolName)} call each — ${printable(report.target)} (${report.mode} mode)`,
    `  ${report.ok}/${report.connections} succeeded, ${report.failed} failed, ` +
      `${report.distinctSessionIds} distinct session ids, ${ms(report.wallClockMs)} wall clock`,
    line('connect', report.connect),
    line('call', report.call),
    line('total', report.total),
  ];
  if (report.failures.length === 0) {
    lines.push('  no failure reproduced');
  } else {
    for (const f of report.failures) {
      lines.push(`  FAILED #${f.index} at ${f.stage} after ${ms(f.totalMs)}: ${printable(f.error ?? '')}`);
    }
  }
  return lines.join('\n');
}

/**
 * The id out of a `tools/call` result. The tool answers `{ sessionId }`, which
 * reaches a client either as `structuredContent` or — the shape the KB surface
 * actually sends — as one JSON text block. Read both rather than betting on
 * one, and treat "answered, but with no id in it" as a failure of its own
 * (`parse`): a 200 carrying nothing usable is not a success.
 */
export function readSessionId(result: unknown): string | undefined {
  const res = (result ?? {}) as { structuredContent?: unknown; content?: unknown };
  const structured = (res.structuredContent as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof structured === 'string' && structured) return structured;
  const blocks = Array.isArray(res.content) ? res.content : [];
  for (const block of blocks) {
    const b = block as { type?: unknown; text?: unknown };
    if (b.type !== 'text' || typeof b.text !== 'string') continue;
    try {
      const parsed = JSON.parse(b.text) as { sessionId?: unknown };
      if (typeof parsed?.sessionId === 'string' && parsed.sessionId) return parsed.sessionId;
    } catch {
      // Not JSON — an error string, or prose. Keep looking at the other blocks.
    }
  }
  return undefined;
}

interface AttemptContext {
  /** Already normalized AND already parsed — see `normalizeBaseUrl`. */
  baseUrl: string;
  bearer: string;
  toolName: string;
  timeoutMs: number;
  now: () => number;
}

/** A fresh MCP client and transport per attempt: handshake, then one call. */
async function mcpAttempt(index: number, ctx: AttemptContext): Promise<FirstCallAttempt> {
  const started = ctx.now();
  const transport = new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${ctx.bearer}` } },
  });
  const client = new Client({ name: 'first-call-probe', version: '1.0.0' }, { capabilities: {} });
  let connectMs = 0;
  try {
    await client.connect(transport, { timeout: ctx.timeoutMs });
    connectMs = ctx.now() - started;
  } catch (err) {
    // The handshake never completed, so there is no client to close beyond the
    // transport the failed connect already owns.
    await transport.close().catch(() => {});
    return { index, ok: false, connectMs: ctx.now() - started, callMs: 0, totalMs: ctx.now() - started, stage: 'connect', error: errorText(err) };
  }
  const calledAt = ctx.now();
  try {
    const result = await client.callTool({ name: ctx.toolName, arguments: {} }, undefined, { timeout: ctx.timeoutMs });
    const callMs = ctx.now() - calledAt;
    const totalMs = ctx.now() - started;
    // A tool-level error comes back as a RESULT with `isError`, not as a throw:
    // unwrap it, or the probe would score a platform failure as a success.
    if (result.isError) {
      const text = Array.isArray(result.content)
        ? (result.content.find((c) => (c as { type?: unknown }).type === 'text') as { text?: string } | undefined)?.text
        : undefined;
      return { index, ok: false, connectMs, callMs, totalMs, stage: 'call', error: text ?? 'tool returned isError with no text' };
    }
    const sessionId = readSessionId(result);
    if (!sessionId) {
      return { index, ok: false, connectMs, callMs, totalMs, stage: 'parse', error: 'result carried no sessionId' };
    }
    return { index, ok: true, connectMs, callMs, totalMs, sessionId };
  } catch (err) {
    return { index, ok: false, connectMs, callMs: ctx.now() - calledAt, totalMs: ctx.now() - started, stage: 'call', error: errorText(err) };
  } finally {
    await client.close().catch(() => {});
  }
}

/** One plain POST to the tool route — the same call with the transport removed. */
async function toolAttempt(index: number, ctx: AttemptContext): Promise<FirstCallAttempt> {
  const started = ctx.now();
  try {
    const res = await fetch(`${ctx.baseUrl}/api/agent/tools/${ctx.toolName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.bearer}` },
      body: '{}',
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
    const text = await res.text();
    const elapsed = ctx.now() - started;
    if (!res.ok) {
      return { index, ok: false, connectMs: 0, callMs: elapsed, totalMs: elapsed, stage: 'call', error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    // The route answers the tool's JSON directly, so the id is one level up
    // from where a `tools/call` result keeps it.
    let sessionId: string | undefined;
    try {
      const parsed = JSON.parse(text) as { sessionId?: unknown };
      if (typeof parsed?.sessionId === 'string' && parsed.sessionId) sessionId = parsed.sessionId;
    } catch {
      // Left undefined: reported as `parse` below, with the body in the error.
    }
    if (!sessionId) {
      return { index, ok: false, connectMs: 0, callMs: elapsed, totalMs: elapsed, stage: 'parse', error: `no sessionId in: ${text.slice(0, 200)}` };
    }
    return { index, ok: true, connectMs: 0, callMs: elapsed, totalMs: elapsed, sessionId };
  } catch (err) {
    const elapsed = ctx.now() - started;
    return { index, ok: false, connectMs: 0, callMs: elapsed, totalMs: elapsed, stage: 'call', error: errorText(err) };
  }
}

/**
 * A count the probe can actually run with, or a refusal naming the option.
 *
 * `runPooled` clamps its limit with `Math.max(1, …)`, so a `concurrency` of 0
 * or -5 would quietly become a one-at-a-time run — the opposite of the burst
 * the caller asked for, reported as though it were the burst. A number that
 * cannot be honoured is answered, not reinterpreted.
 */
/**
 * An option the probe cannot run with — a malformed base URL, a count that is
 * not a count. Its own class so a front end can tell the operator's typo
 * (usage, exit 2) from a probe that crashed (exit 1) without reading prose.
 */
export class ProbeOptionsError extends Error {}

function positiveInt(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new ProbeOptionsError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

/**
 * The base URL, trailing slashes removed, checked once.
 *
 * `new URL(...)` throws synchronously, and `mcpAttempt` builds one before its
 * own `try` — inside a pool worker. Left there, an empty or malformed
 * `--base-url` would reject `Promise.all` and take all fifty results down
 * with it, which is exactly what this probe promises never to do. It is also
 * not an attempt failure: nothing was attempted. So it is raised here, before
 * the burst, in the same class as a bad `connections` — and both modes answer
 * a bad URL the same way, rather than `'tool'` recording fifty copies of a
 * parse error while `'mcp'` threw.
 */
function normalizeBaseUrl(baseUrl: string): string {
  // A trailing slash would make the joined path `//api/mcp`, which some
  // proxies answer differently from `/api/mcp`.
  const trimmed = baseUrl.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ProbeOptionsError(`baseUrl must be an absolute URL, got ${printable(baseUrl)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProbeOptionsError(`baseUrl must be http or https, got ${printable(baseUrl)}`);
  }
  return trimmed;
}

/**
 * Run `count` tasks with at most `limit` in flight. At the default
 * `limit === count` every task starts in the same tick, which is the burst the
 * probe is for; a smaller limit is there for an endpoint one would rather not
 * hit fifty-wide.
 */
async function runPooled<T>(count: number, limit: number, task: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      results[index] = await task(index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, count)) }, worker));
  return results;
}

/**
 * Open `connections` fresh connections, make exactly one first call on each,
 * and report. Never throws for a failed attempt — a thrown probe would lose
 * the other forty-nine results, and those are the evidence. It DOES throw for
 * arguments it cannot probe with at all (a count that is not a positive
 * integer, a base URL that is not an absolute http(s) URL), and it throws
 * before the burst starts, so
 * there is never a half-run whose numbers mean nothing.
 */
export async function probeFirstCall(options: FirstCallProbeOptions): Promise<FirstCallProbeReport> {
  const connections = positiveInt('connections', options.connections, DEFAULT_CONNECTIONS);
  // Clamped to `connections` further down, so asking for more in flight than
  // there are attempts is merely the default; asking for zero or less is not a
  // smaller burst, it is a request the probe cannot honour.
  const concurrency = positiveInt('concurrency', options.concurrency, connections);
  const timeoutMs = positiveInt('timeoutMs', options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const mode = options.mode ?? 'mcp';
  const now = options.now ?? (() => performance.now());
  const ctx: AttemptContext = {
    baseUrl: normalizeBaseUrl(options.baseUrl),
    bearer: options.bearer,
    toolName: options.toolName ?? 'start_session',
    timeoutMs,
    now,
  };
  const attempt = mode === 'mcp' ? mcpAttempt : toolAttempt;
  const startedAt = now();
  const attempts = await runPooled(connections, concurrency, (index) => attempt(index, ctx));
  return summarizeProbe(attempts, { target: ctx.baseUrl, mode, toolName: ctx.toolName, wallClockMs: now() - startedAt });
}
