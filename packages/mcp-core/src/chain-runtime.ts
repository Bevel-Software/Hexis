import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { utcpNameToTsInterfaceName } from './code-mode-names.js';
import { describeToolFailure } from './results.js';

/**
 * What runs a `call_tool_chain` chain, for every surface that offers one: the
 * hosted MCP proxy, the local `hexis-mcp` server and the in-process agent's
 * Mastra tool.
 *
 * Three things live here because all three surfaces need them to be the same:
 *
 *  - the BROWSER GLOBALS a chain is promised (`atob`, `btoa`, `TextEncoder`,
 *    `TextDecoder`). `@utcp/code-mode` runs the chain in a bare `isolated-vm`
 *    isolate — plain V8, so no Node globals (`Buffer`) and no web platform
 *    (`atob`), and a chain could not decode base64 or bytes at all. They are
 *    added as a PRELUDE to the chain's own source rather than injected into
 *    the isolate's context, because the isolate is created inside
 *    `callToolChain` and is reachable from nowhere else (see
 *    {@link CHAIN_RUNTIME_PRELUDE});
 *  - the ANSWER for a chain that failed. `callToolChain` does not throw when
 *    the chain dies: it resolves `{ result: null, logs: ['[ERROR] Code
 *    execution failed: …'] }`, so a surface that read only `result` reported
 *    `success: true` with a null result and the agent was told nothing. Every
 *    failure — a timeout, an undefined namespace, a tool that threw — becomes
 *    an error that says what happened;
 *  - the promise that a chain ALWAYS answers. A request that never settles is
 *    what reaches an agent as a dropped connection rather than as something it
 *    can act on, so the runner is raced against a watchdog (see
 *    {@link WATCHDOG_GRACE_MS}).
 */

/**
 * The largest `timeout` a chain may ask for, in milliseconds. One constant: it
 * is the schema's bound on every surface AND the figure the timeout error tells
 * the agent it may raise `timeout` to, and those two drifting apart would send
 * an agent to retry with a value the schema then clamps straight back down.
 */
export const CHAIN_TIMEOUT_MAX_MS = 120_000;

/** The smallest `timeout` a chain may ask for, in milliseconds. */
export const CHAIN_TIMEOUT_MIN_MS = 1_000;

/** The `timeout` a chain that does not ask for one gets, in milliseconds. */
export const CHAIN_TIMEOUT_DEFAULT_MS = 30_000;

/**
 * How long past its own `timeout` the runner is given to answer before the
 * watchdog answers for it. `callToolChain` enforces the timeout itself and so
 * normally settles well inside this; the watchdog covers the case where it does
 * not, where the alternative is a request that hangs until the client gives up
 * — the dropped connection an agent cannot tell from a crash.
 */
const WATCHDOG_GRACE_MS = 5_000;

/** The log line `@utcp/code-mode` records when a chain's code fails. */
const CHAIN_FAILURE_LOG = '[ERROR] Code execution failed: ';

/** The runner's own wording for a chain it stopped at the timeout. */
const RUNNER_TIMEOUT = /Script execution timeout after (\d+)\s*ms/;

/** `isolated-vm`'s wording when V8 itself terminated the script at the deadline. */
const ISOLATE_TERMINATED = /Script execution timed out|execution was terminated|script execution interrupted/i;

/** `isolated-vm`'s wording when the chain exhausted the isolate's heap. */
const ISOLATE_OUT_OF_MEMORY = /memory limit|out of memory|allocation failed/i;

/** The identifier a chain named that the isolate has no binding for. */
const UNDEFINED_IDENTIFIER = /ReferenceError: ([A-Za-z_$][\w$]*) is not defined/;

/**
 * The browser globals, as ONE physical line of plain ES5 JavaScript.
 *
 * One line on purpose. The prelude is prepended to the agent's own chain
 * source, and a failed chain is reported with its stack in it; a multi-line
 * prelude would shift every line number in that stack and point the agent at
 * the wrong line of its own code. Prepended WITHOUT a trailing newline for the
 * same reason, so the chain's first line stays line one. (The one casualty is
 * a `'use strict'` directive written as a chain's first statement, which is no
 * longer in first position and so no longer applies. A chain is a handful of
 * statements against a tool catalog, and strict mode is not something the
 * chain protocol ever offered.)
 *
 * `atob`/`btoa` follow WHATWG forgiving-base64: ASCII whitespace is stripped,
 * the padding is optional, and anything else throws rather than decoding to
 * silent garbage. `TextEncoder`/`TextDecoder` are UTF-8 only — that is the
 * encoding the Specification asks for, and a decoder that took a `label` it
 * then ignored would quietly answer mojibake. `TextDecoder` drops a leading
 * byte-order mark the way a browser's default does, and keeps it under
 * `{ ignoreBOM: true }`: a chain decoding a UTF-8 file written on Windows would
 * otherwise find a stray `\uFEFF` at the front of it, which breaks a
 * `JSON.parse` and every exact-match comparison. Each is defined only when the
 * runtime does not already have it, so a future `@utcp/code-mode` that ships
 * them natively wins.
 */
export const CHAIN_RUNTIME_PRELUDE: string = [
  '(function(g){',
  "var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';",
  'if(typeof g.btoa!=="function"){g.btoa=function(input){',
  'var s=String(input),i,o="";',
  'for(i=0;i<s.length;i++){if(s.charCodeAt(i)>255)throw new Error("InvalidCharacterError: btoa() takes a string whose every character is in the Latin-1 range (0-255). To base64 text, encode it to UTF-8 bytes with TextEncoder first.");}',
  'for(i=0;i<s.length;i+=3){',
  'var b0=s.charCodeAt(i),b1=s.charCodeAt(i+1),b2=s.charCodeAt(i+2),h1=!isNaN(b1),h2=!isNaN(b2);',
  'o+=A.charAt(b0>>2)+A.charAt(((b0&3)<<4)|(h1?b1>>4:0));',
  'o+=(h1?A.charAt(((b1&15)<<2)|(h2?b2>>6:0)):"=")+(h2?A.charAt(b2&63):"=");',
  '}return o;};}',
  'if(typeof g.atob!=="function"){g.atob=function(input){',
  'var s=String(input).replace(/[\\t\\n\\f\\r ]/g,"");',
  'if(s.length%4===0)s=s.replace(/==?$/,"");',
  'if(s.length%4===1||/[^+\\/0-9A-Za-z]/.test(s))throw new Error("InvalidCharacterError: atob() was given a string that is not valid base64.");',
  'var o="",buf=0,bits=0,i;',
  'for(i=0;i<s.length;i++){buf=(buf<<6)|A.indexOf(s.charAt(i));bits+=6;',
  'if(bits>=8){bits-=8;o+=String.fromCharCode((buf>>bits)&255);}}',
  'return o;};}',
  'if(typeof g.TextEncoder!=="function"){',
  'var TE=function TextEncoder(){};',
  'TE.prototype.encoding="utf-8";',
  'TE.prototype.encode=function(input){',
  'var s=String(input===undefined?"":input),out=[],i=0;',
  'while(i<s.length){var c=s.codePointAt(i);i+=c>65535?2:1;',
  'if(c<128)out.push(c);',
  'else if(c<2048)out.push(192|(c>>6),128|(c&63));',
  'else if(c>=55296&&c<=57343)out.push(239,191,189);',
  'else if(c<65536)out.push(224|(c>>12),128|((c>>6)&63),128|(c&63));',
  'else out.push(240|(c>>18),128|((c>>12)&63),128|((c>>6)&63),128|(c&63));}',
  'return new Uint8Array(out);};',
  'g.TextEncoder=TE;}',
  'if(typeof g.TextDecoder!=="function"){',
  'var TD=function TextDecoder(label,options){',
  'var e=String(label===undefined?"utf-8":label).toLowerCase();',
  'if(e!=="utf-8"&&e!=="utf8"&&e!=="unicode-1-1-utf-8")throw new RangeError("TextDecoder(): the tool-chain runtime decodes UTF-8 only, not \\""+label+"\\".");',
  'this.ignoreBOM=!!(options&&options.ignoreBOM);};',
  'TD.prototype.encoding="utf-8";',
  'TD.prototype.ignoreBOM=false;',
  'TD.prototype.decode=function(input){',
  'if(input===undefined||input===null)return "";',
  'var b=input instanceof Uint8Array?input:(input instanceof ArrayBuffer?new Uint8Array(input):(input&&input.buffer instanceof ArrayBuffer?new Uint8Array(input.buffer,input.byteOffset,input.byteLength):new Uint8Array(input)));',
  'var o="",n=b.length,need=0,seen=0,c=0,lo=128,hi=191,x,t;',
  'var i=(!this.ignoreBOM&&n>=3&&b[0]===239&&b[1]===187&&b[2]===191)?3:0;',
  'while(i<n){x=b[i];',
  'if(need===0){i++;',
  'if(x<128)o+=String.fromCharCode(x);',
  'else if(x>=194&&x<=223){need=1;c=x&31;}',
  'else if(x>=224&&x<=239){if(x===224)lo=160;if(x===237)hi=159;need=2;c=x&15;}',
  'else if(x>=240&&x<=244){if(x===240)lo=144;if(x===244)hi=143;need=3;c=x&7;}',
  'else o+="\\uFFFD";',
  'continue;}',
  'if(x<lo||x>hi){need=0;seen=0;c=0;lo=128;hi=191;o+="\\uFFFD";continue;}',
  'lo=128;hi=191;i++;c=(c<<6)|(x&63);seen++;',
  'if(seen===need){',
  'if(c<=65535)o+=String.fromCharCode(c);',
  'else{t=c-65536;o+=String.fromCharCode(55296+(t>>10),56320+(t&1023));}',
  'need=0;seen=0;c=0;}}',
  'if(need!==0)o+="\\uFFFD";',
  'return o;};',
  'g.TextDecoder=TD;}',
  '})(globalThis);',
].join('');

/**
 * The agent's chain source with the runtime prelude in front of it, on the same
 * physical line, so a stack from the chain still names the chain's own line
 * numbers (see {@link CHAIN_RUNTIME_PRELUDE}).
 */
export function withChainRuntime(code: string): string {
  return `${CHAIN_RUNTIME_PRELUDE}${code}`;
}

/** The outcome of a chain: either its value, or the reason it has none. */
export type ToolChainOutcome =
  | { ok: true; result: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[]; status?: number; data?: unknown };

/** The namespaces and bare functions a chain can call, as the runtime spells them. */
export interface ChainNamespaces {
  namespaces: string[];
  bare: string[];
}

/**
 * What a chain can actually call. `@utcp/code-mode` gives every tool whose UTCP
 * name is `MANUAL.tool` a `global.MANUAL` object, so the namespaces are the
 * sanitized manual names — and a tool registered under a bare name becomes a
 * global function rather than a namespace, which is why those are listed apart.
 */
export async function chainNamespaces(client: CodeModeUtcpClient): Promise<ChainNamespaces> {
  const namespaces = new Set<string>();
  const bare = new Set<string>();
  for (const tool of await client.config.tool_repository.getTools()) {
    const tsName = utcpNameToTsInterfaceName(tool.name);
    const dot = tsName.indexOf('.');
    if (dot > 0) namespaces.add(tsName.slice(0, dot));
    else bare.add(tsName);
  }
  return { namespaces: [...namespaces].sort(), bare: [...bare].sort() };
}

/** What a chain is told when it timed out: the limit it hit, and how to raise it. */
export function chainTimeoutMessage(timeoutMs: number): string {
  return (
    `The tool chain timed out after ${timeoutMs} ms and was stopped, so it has no result. ` +
    `Raise \`timeout\` (milliseconds, up to a maximum of ${CHAIN_TIMEOUT_MAX_MS}) and run it again, ` +
    'or split the work across several shorter chains. The connection is unaffected — your next tool call works as usual.'
  );
}

/** What a chain is told when it exhausted the isolate's heap. */
export function chainOutOfMemoryMessage(reason: string): string {
  return (
    `The tool chain ran out of memory and was stopped, so it has no result (${reason}). ` +
    'Return less from the chain — filter, map or count inside it instead of accumulating every record — ' +
    'or split the work across several chains. The connection is unaffected — your next tool call works as usual.'
  );
}

/** What a chain is told when it named something the runtime has no binding for. */
export function unknownNamespaceMessage(identifier: string, found: ChainNamespaces): string {
  const { namespaces, bare } = found;
  const existing = namespaces.length
    ? `The tool namespaces this connection exposes are: ${namespaces.join(', ')}.`
    : 'This connection exposes no tool namespaces at all.';
  const example = namespaces[0] ? ` Call a tool as \`${namespaces[0]}.<tool>({ body: { … } })\`.` : '';
  const bareNote = bare.length ? ` Callable without a namespace: ${bare.join(', ')}.` : '';
  return (
    `ReferenceError: ${identifier} is not defined — "${identifier}" is not one of them. ` +
    `${existing}${example}${bareNote} Use \`list_tools\` for the exact callable names.`
  );
}

/**
 * Why a RESOLVED `callToolChain` is a failure, or undefined when it is not one.
 *
 * `callToolChain` resolves rather than throws on a dead chain, reporting it as
 * a `[ERROR] Code execution failed: …` log line with a null result. Both halves
 * are required: a chain that returned a value succeeded however it logged.
 *
 * The LAST such line, not the last line: the runner appends its own entry in a
 * `catch` and then, in the `finally`, a `[WARN] Tool call "…" abandoned` line
 * per tool call still in flight — so a chain that timed out mid-call has the
 * reason second-from-last or further back. A chain that prints that exact
 * prefix itself through `console.error` AND returns null is read as a failure;
 * that trade is deliberate, since the alternative — a dead chain reported as a
 * success with a null result — is the bug this replaces.
 */
function failureReason(outcome: { result: unknown; logs: string[] }): string | undefined {
  if (outcome.result !== null && outcome.result !== undefined) return undefined;
  for (let i = outcome.logs.length - 1; i >= 0; i -= 1) {
    const line = outcome.logs[i];
    if (typeof line === 'string' && line.startsWith(CHAIN_FAILURE_LOG)) {
      return line.slice(CHAIN_FAILURE_LOG.length);
    }
  }
  return undefined;
}

/**
 * Turn the runner's reason into the sentence the agent reads. A timeout, an
 * exhausted heap and an undefined namespace each get their own; anything else
 * passes through exactly as the runner reported it, so a real cause is never
 * replaced by a guess.
 */
export async function describeChainFailure(
  client: CodeModeUtcpClient,
  reason: string,
  timeoutMs: number,
): Promise<string> {
  // Memory before termination: an isolate killed for its heap reports being
  // disposed too, and calling that a timeout would send the agent to raise a
  // limit that was never the problem.
  if (ISOLATE_OUT_OF_MEMORY.test(reason)) return chainOutOfMemoryMessage(reason);
  const runnerTimeout = RUNNER_TIMEOUT.exec(reason);
  if (runnerTimeout) return chainTimeoutMessage(Number(runnerTimeout[1]));
  if (ISOLATE_TERMINATED.test(reason)) return chainTimeoutMessage(timeoutMs);
  const undefinedIdentifier = UNDEFINED_IDENTIFIER.exec(reason);
  if (undefinedIdentifier) {
    // The namespace list costs one catalog read, so it is fetched only on the
    // failure that needs it. A catalog that cannot be read must not replace the
    // chain's own reason with an unrelated one: the agent keeps the
    // ReferenceError, just without the list.
    try {
      return unknownNamespaceMessage(undefinedIdentifier[1]!, await chainNamespaces(client));
    } catch {
      return reason;
    }
  }
  return reason;
}

/**
 * Run a chain and ALWAYS answer: with its value, or with the reason it has
 * none. Never throws, and never leaves a caller waiting past the chain's own
 * timeout plus {@link WATCHDOG_GRACE_MS}.
 *
 * What the caller does with an error is still the caller's (the hosted proxy
 * maps a retired tool's name onto its own message first, for instance); this
 * decides only whether there IS one and what it says about the runtime.
 */
export async function runToolChain(
  client: CodeModeUtcpClient,
  code: string,
  timeoutMs: number,
): Promise<ToolChainOutcome> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const watchdogFired = new Promise<'watchdog'>((resolve) => {
      watchdog = setTimeout(() => resolve('watchdog'), timeoutMs + WATCHDOG_GRACE_MS);
      // A watchdog nobody is waiting on must not hold a CLI's exit open.
      (watchdog as unknown as { unref?: () => void }).unref?.();
    });
    const settled = await Promise.race([
      client.callToolChain(withChainRuntime(code), timeoutMs).then((outcome) => ({ outcome })),
      watchdogFired,
    ]);
    if (settled === 'watchdog') return { ok: false, error: chainTimeoutMessage(timeoutMs), logs: [] };
    const logs = Array.isArray(settled.outcome.logs) ? settled.outcome.logs : [];
    const reason = failureReason({ result: settled.outcome.result, logs });
    if (reason !== undefined) {
      return { ok: false, error: await describeChainFailure(client, reason, timeoutMs), logs };
    }
    return { ok: true, result: settled.outcome.result, logs };
  } catch (err) {
    // Everything the runner throws BEFORE the chain starts (a catalog read, a
    // registry outage) and anything a tool bridge rethrows. The http transport
    // carries a status and a body on a tool failure, and both are worth more to
    // the agent than the message on its own.
    //
    // `describeToolFailure` is what reads the PROVIDER's own reason out of such
    // a failure — `response.data.error`, with the machine-readable `kind` kept
    // beside it on a typed refusal. The MCP dispatcher used to call it on the
    // thrown error itself; now that the catch lives here, taking `err.message`
    // instead would hand the agent a generic transport line and drop the half
    // it can act on.
    const error = describeToolFailure(err);
    let status: unknown;
    let data: unknown;
    try {
      const e = err as { status?: unknown; data?: unknown; response?: { status?: unknown; data?: unknown } };
      status = e?.status ?? e?.response?.status;
      data = e?.data ?? e?.response?.data;
    } catch {
      // A throwing getter or Proxy says nothing about the failure; the message
      // above already stands on its own.
    }
    return {
      ok: false,
      error,
      logs: [],
      ...(typeof status === 'number' ? { status } : {}),
      ...(data !== undefined ? { data } : {}),
    };
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}
