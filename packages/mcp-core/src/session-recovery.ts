import type { CodeModeUtcpClient } from '@utcp/code-mode';
import type { CallTemplate } from '@utcp/sdk';
import { registerManual } from './dispatch.js';

/**
 * Client-side recovery from MCP session loss: when a remote MCP server has
 * forgotten the session our manual holds — almost always because it restarted —
 * re-register that manual once and retry the call once.
 *
 * WHY IT LIVES ON THE CLIENT OBJECT. Two paths reach a tool call in our stack:
 * `dispatchToolCall` (the MCP surface of the hosted proxy and of the local
 * server) goes through `callToolStreaming`, and a code-mode chain
 * (`call_tool_chain`, gate probes) goes through `callTool` — `callToolChain`
 * bridges every in-isolate tool function to `this.callTool`. Wrapping those two
 * methods ON THE CLIENT INSTANCE is the one seam both paths cross, so the
 * policy exists exactly once instead of being copied into each caller.
 *
 * WHY ONLY SESSION LOSS. A retry is only safe when the first attempt provably
 * did nothing. Session loss is decided in the server's ROUTING layer, before
 * the request is dispatched to a tool, so a mutating tool cannot have run.
 * Every other failure — a tool error, an auth refusal, a timeout, a reset
 * connection — could have executed the tool, and is surfaced unchanged. That is
 * the whole safety argument: it rests on the trigger class, so
 * {@link isSessionLoss} is deliberately narrow and separately testable.
 */

/** The JSON-RPC code the Streamable HTTP transport reserves for a missing session. */
const SESSION_NOT_FOUND_CODE = -32001;

/** How far up a `cause` chain to look before giving up. */
const MAX_CAUSE_DEPTH = 8;

/** Each error in `err`'s `cause` chain, nearest first, bounded and cycle-safe. */
function* errorChain(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * The HTTP status an error carries, or undefined when it carries none.
 *
 * The MCP SDK's `StreamableHTTPError` puts the HTTP status in `code`, which is
 * also where `McpError` puts its JSON-RPC code — and those two namespaces
 * OVERLAP on the very number this module cares about: `-32001` is "Session not
 * found" on the wire but `ErrorCode.RequestTimeout` in the SDK's own enum. The
 * range test is what keeps them apart: a JSON-RPC code is negative and can
 * never be read as a status, so a local request timeout never looks like a
 * session miss (and is never retried).
 */
function httpStatusOf(err: Record<string, unknown>): number | undefined {
  for (const key of ['code', 'status', 'statusCode'] as const) {
    const value = err[key];
    if (typeof value === 'number' && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

/**
 * Does this error's text carry the session-not-found signal?
 *
 * The transport surfaces a failed POST as `Error POSTing to endpoint: <body>`,
 * so the server's JSON-RPC body rides along in the message and is the only
 * place the `-32001` is visible. Both halves of the spec's signal are accepted
 * — the code (structural) and the reserved message — because a server may send
 * either; requiring the 404 alongside is what keeps this from over-matching.
 */
function saysSessionNotFound(message: string): boolean {
  return (
    new RegExp(`"code"\\s*:\\s*${SESSION_NOT_FOUND_CODE}\\b`).test(message) ||
    /\bsession not found\b/i.test(message)
  );
}

/**
 * Is `err` unambiguously "the server has forgotten this session"?
 *
 * The signal is HTTP 404 carrying JSON-RPC `-32001` / "Session not found", which
 * the MCP spec reserves for exactly one meaning: the request presented an
 * `Mcp-Session-Id` the server no longer holds, and the client should
 * re-initialize. The presented-a-session-id half is not observable from here,
 * and does not need to be: a request with NO session id is answered 400 /
 * `-32000` (a client mistake with nothing to recover), so a 404 in this shape
 * implies a session id was sent.
 *
 * Everything else is false — including a 404 whose body is an ordinary
 * not-found, an auth refusal, a timeout (see {@link httpStatusOf}), and a
 * refused connection. Pure and exported so this boundary can be pinned by test
 * rather than inferred from the recovery path around it.
 */
export function isSessionLoss(err: unknown): boolean {
  for (const candidate of errorChain(err)) {
    if (httpStatusOf(candidate) !== 404) continue;
    const message = candidate.message;
    if (typeof message === 'string' && saysSessionNotFound(message)) return true;
  }
  return false;
}

export interface SessionRecoveryOptions {
  /**
   * The template to re-register `manualName` with, or undefined when this
   * surface holds none — an unknown manual is not recovered, and its failure
   * surfaces unchanged.
   *
   * Resolved at RECOVERY time, not at install time, so a manual whose template
   * carries a credential that can be rotated (the local server renews its
   * connection key) re-registers with the current one. May be async, which is
   * also the hook a surface uses to wait out a re-registration of its own that
   * is already in flight.
   */
  manualTemplate: (manualName: string) => CallTemplate | undefined | Promise<CallTemplate | undefined>;
  /**
   * Ran after a successful re-registration. Re-registration REDISCOVERS the
   * manual, so a surface that prunes something from the registry at first
   * registration (the local server drops the deployment's copies of the
   * code-mode meta-tools) has to prune it again here.
   */
  afterReregister?: (manualName: string) => Promise<void> | void;
  /**
   * Runs one whole re-registration — resolve the template, deregister,
   * register, clean up — for a surface that has a re-registration path of its
   * own. `hexis-mcp` renews its connection key by re-registering the remote
   * manual and holds arriving calls while it does; handing that same gate in
   * here makes the two ONE serialized operation instead of two that can
   * interleave (the window between a deregister and its register finds no
   * manual in the repository) or, worse, wait on each other. Whatever `run`
   * settles to is what recovery uses; a hook that throws counts as a failed
   * recovery, never as a failed call. Defaults to running `run` directly.
   */
  withReregister?: <T>(manualName: string, run: () => Promise<T>) => Promise<T>;
  /** Where the one-line-per-recovery log goes. Defaults to stderr. */
  log?: (message: string) => void;
}

/** What one re-registration produced: may we retry, and anything odd worth saying. */
interface ReregisterOutcome {
  /** True only when the manual now holds a fresh session. */
  ok: boolean;
  /**
   * True when the fresh session was somebody else's work — this call waited
   * for a re-registration already under way and inherited its result rather
   * than dialing a third session.
   */
  reused?: boolean;
  /**
   * Abnormalities met on the way. Folded into the ONE line the recovered call
   * logs rather than printed as they happen: a recovery is a single event, and
   * two lines for one read as two recoveries — which is how a retry loop that
   * never existed gets diagnosed.
   */
  notes: string[];
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Per-client re-registration counters, keyed by manual — the same maps the
 * installed recovery reads, reachable from {@link noteManualReregistered} so a
 * surface can report a re-registration of its own.
 */
const GENERATIONS = new WeakMap<object, Map<string, number>>();

/**
 * Tell recovery that `manualName`'s session was replaced by something OTHER
 * than recovery. `hexis-mcp` re-registers the remote manual whenever a renewed
 * connection key arrives; a call that lost its session around such a swap must
 * then retry against THAT session instead of deregistering it and dialing a
 * third one. Without this the two paths each replace a session the other just
 * made — correct, but a round trip and a discovery pass wasted on every
 * overlap. No-op when recovery is not installed on `client`.
 */
export function noteManualReregistered(client: CodeModeUtcpClient, manualName: string): void {
  const generations = GENERATIONS.get(client as unknown as object);
  if (!generations) return;
  generations.set(manualName, (generations.get(manualName) ?? 0) + 1);
}

/**
 * Wrap `client`'s tool-call entry points with session recovery, in place.
 *
 * Returns the same client so it can be used as an expression at the
 * construction site. Installing twice is a no-op: the second call would stack a
 * second retry on the first, which is precisely the "exactly once" guarantee
 * this module exists to make.
 */
const INSTALLED = Symbol.for('@bevel-software/platform-mcp-core.sessionRecovery');

export function installSessionRecovery(
  client: CodeModeUtcpClient,
  options: SessionRecoveryOptions,
): CodeModeUtcpClient {
  const marked = client as unknown as Record<symbol, unknown>;
  if (marked[INSTALLED]) return client;
  marked[INSTALLED] = true;

  const log = options.log ?? ((message: string) => console.error(message));
  const callTool = client.callTool.bind(client);
  const callToolStreaming = client.callToolStreaming.bind(client);

  /**
   * How many times each manual has been re-registered. A call reads this
   * BEFORE its attempt; if the number moved while the attempt was in flight,
   * some other call already replaced the session this one was using and the
   * retry can go straight through — no second re-registration, and no window
   * in which a burst of failures that arrive slightly apart each starts its
   * own. Together with `inflight` below, this is what makes the coalescing
   * hold for concurrent calls whether they fail together or in sequence.
   */
  const generations = new Map<string, number>();
  GENERATIONS.set(client as unknown as object, generations);
  const inflight = new Map<string, Promise<ReregisterOutcome>>();

  const generationOf = (manualName: string): number => generations.get(manualName) ?? 0;

  /**
   * Deregister + register once. Reports what happened; the caller does the
   * logging. `generation` is what the failing call saw before its attempt: if
   * the counter has moved by the time this runs — a surface gate can hold a
   * recovery while the surface's own credential swap re-registers the very
   * same manual — the session has ALREADY been replaced, and replacing it
   * again would throw away a live session to dial an identical one.
   */
  async function reregisterNow(manualName: string, generation: number): Promise<ReregisterOutcome> {
    const notes: string[] = [];
    if (generationOf(manualName) !== generation) return { ok: true, reused: true, notes };
    const template = await options.manualTemplate(manualName);
    // Not ours to re-register — or not an MCP manual at all, in which case it
    // holds no session and the 404 came from somewhere we must not second-guess.
    // Silent on purpose: nothing happened, so there is nothing to report.
    if (!template || template.call_template_type !== 'mcp') return { ok: false, notes };
    try {
      // Deregistering is what closes the manual's (now dead) session, so the
      // registration below dials a fresh one instead of reusing the cached
      // transport. Best effort: a manual already gone is not a failure here.
      await client.deregisterManual(manualName);
    } catch (err) {
      notes.push(`deregistering first failed: ${messageOf(err)}`);
    }
    const result = await registerManual(client, template);
    if (!result.ok) {
      // The server is very likely still coming back up. The call fails as it
      // would have anyway; the NEXT one recovers once the server answers.
      notes.push(`re-registration failed: ${result.error}`);
      return { ok: false, notes };
    }
    generations.set(manualName, generationOf(manualName) + 1);
    if (options.afterReregister) {
      try {
        await options.afterReregister(manualName);
      } catch (err) {
        notes.push(`post-re-registration cleanup failed: ${messageOf(err)}`);
      }
    }
    return { ok: true, notes };
  }

  /**
   * {@link reregisterNow} under the surface's own gate, if it has one, and with
   * every escape route closed. NEVER throws — and that is load-bearing: a
   * throwing template resolver (or gate) must not replace the caller's real
   * session-loss error with a recovery-internal one. The answer here is only
   * ever "may we retry?".
   */
  async function reregister(manualName: string, generation: number): Promise<ReregisterOutcome> {
    try {
      return options.withReregister
        ? await options.withReregister(manualName, () => reregisterNow(manualName, generation))
        : await reregisterNow(manualName, generation);
    } catch (err) {
      return { ok: false, notes: [`re-registration threw: ${messageOf(err)}`] };
    }
  }

  /**
   * Single-flight {@link reregister}: concurrent losers share one attempt.
   *
   * The generation belongs to whoever started the attempt, and that is right
   * for the joiners too — {@link recover} sends nobody here whose generation
   * differs from the current one, so every sharer of this promise failed
   * against the same session.
   */
  function reregisterOnce(manualName: string, generation: number): Promise<ReregisterOutcome> {
    const existing = inflight.get(manualName);
    if (existing) return existing;
    const tracked = reregister(manualName, generation).finally(() => {
      if (inflight.get(manualName) === tracked) inflight.delete(manualName);
    });
    inflight.set(manualName, tracked);
    return tracked;
  }

  /**
   * May this failed call be retried? True only for session loss on a manual we
   * hold a template for, and only after the session has actually been replaced.
   */
  async function recover(toolName: string, generation: number, err: unknown): Promise<boolean> {
    if (!isSessionLoss(err)) return false;
    const manualName = toolName.split('.')[0];
    if (!manualName) return false;
    /** The session was replaced by someone else — a concurrent call, or the surface. */
    const alreadyReplaced = (): boolean => {
      log(`[mcp] session lost on '${manualName}' — re-registered by a concurrent call; retrying.`);
      return true;
    };
    // Someone else re-registered while this call was in flight: the session it
    // failed against is already gone, so retry against the new one directly.
    if (generationOf(manualName) !== generation) return alreadyReplaced();
    const outcome = await reregisterOnce(manualName, generation);
    // The same finding, made too late to skip the queue: the re-registration
    // landed while this call waited for the surface's gate.
    if (outcome.reused) return alreadyReplaced();
    // One recovered call, one line — whatever went sideways on the way rides
    // along in it rather than arriving as a line of its own.
    const notes = outcome.notes.length > 0 ? ` (${outcome.notes.join('; ')})` : '';
    if (!outcome.ok) {
      if (notes) {
        log(
          `[mcp] session lost on '${manualName}' — not recovered${notes}; the original failure stands.`,
        );
      }
      return false;
    }
    log(`[mcp] session lost on '${manualName}' — re-registered and retried.${notes}`);
    return true;
  }

  client.callTool = async function recoveringCallTool(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<unknown> {
    const generation = generationOf(toolName.split('.')[0] ?? '');
    try {
      return await callTool(toolName, toolArgs);
    } catch (err) {
      if (!(await recover(toolName, generation, err))) throw err;
      // Exactly one retry: whatever this produces is what the caller sees,
      // including a second session loss.
      return await callTool(toolName, toolArgs);
    }
  };

  client.callToolStreaming = async function* recoveringCallToolStreaming(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): AsyncGenerator<unknown, void, unknown> {
    const generation = generationOf(toolName.split('.')[0] ?? '');
    let yielded = false;
    try {
      for await (const chunk of callToolStreaming(toolName, toolArgs)) {
        yielded = true;
        yield chunk;
      }
      return;
    } catch (err) {
      // A stream that already produced output is past the point where session
      // loss can happen (the session is validated before the first byte), and
      // replaying it would duplicate the chunks the caller already saw.
      if (yielded || !(await recover(toolName, generation, err))) throw err;
    }
    yield* callToolStreaming(toolName, toolArgs);
  };

  return client;
}
