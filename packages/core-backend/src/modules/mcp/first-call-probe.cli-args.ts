/**
 * Argument handling for `first-call-probe.cli.ts`, kept apart from it.
 *
 * The entrypoint is a top-level-`await` script: importing it runs a probe, so
 * nothing there can be tested. Everything that decides what the probe is asked
 * to do lives here instead, as plain functions over an argv array — which is
 * how the refusals below are covered by a suite rather than by remembering to
 * try them by hand.
 */
import { printable } from '../../shared/printable.js';
import type { FirstCallProbeOptions, ProbeMode } from './first-call-probe.js';

export const USAGE = `probe-first-call — fresh connections, one first start_session call each

  --base-url <url>      deployment root, e.g. https://core-staging.bevel.software (required)
  --bearer <token>      connection key or bearer; defaults to $PROBE_BEARER
  --connections <n>     fresh connections to open (default 50)
  --concurrency <n>     attempts in flight (default: all of them, one burst)
  --mode <mcp|tool>     mcp: full client path (default); tool: plain POST, no transport
  --tool <name>         tool to call (default start_session)
  --timeout <ms>        per-request ceiling (default 30000)
  --json                print the full report as JSON instead of the log block
`;

/**
 * An argument the operator has to fix: printed plainly, exit 2, no stack.
 *
 * Its message is composed here and printed straight to a terminal or a CI log,
 * so every value taken from argv goes through `printable` on the way in. A
 * flag value is entirely the caller's to choose, and one containing a newline
 * would otherwise add a line to that log — `--connections "1\n  50/50
 * succeeded"` reading back as a result the probe never produced — while an
 * ANSI escape would restyle whatever followed it.
 */
export class ConfigError extends Error {}

/** `--flag value` pairs plus bare `--flag` switches, with no dependency. */
export function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * A count flag, or `undefined` when absent so the probe's own default stands.
 *
 * Every numeric flag this CLI takes is a count: connections, attempts in
 * flight, milliseconds. None of them has a meaning at zero or below —
 * `--concurrency 0` in particular would reach `runPooled`'s `Math.max(1, …)`
 * and run one worker at a time, so the operator would get a report of a
 * one-at-a-time run labelled as the burst they asked for. Garbage and
 * out-of-range are both refused, before anything is opened.
 */
export function count(args: Record<string, string>, key: string): number | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`--${key} must be a positive integer, got ${printable(raw)}`);
  }
  return parsed;
}

/** What one invocation asked for: the usage text, or a probe to run. */
export type CliRequest = { help: true } | { help: false; json: boolean; options: FirstCallProbeOptions };

/**
 * argv → what to do, or a {@link ConfigError} naming the flag to fix.
 *
 * Only the arguments this file can judge are judged here. Whether the base URL
 * parses is `probeFirstCall`'s to say — it checks that before opening anything
 * — and the entrypoint turns its refusal into the same exit as these.
 */
export function parseCliRequest(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliRequest {
  const args = parseArgs(argv);
  if (args.help || args.h) return { help: true };

  const baseUrl = args['base-url'];
  const bearer = args.bearer ?? env.PROBE_BEARER ?? '';
  if (!baseUrl || !bearer) {
    throw new ConfigError(!baseUrl ? '--base-url is required' : '--bearer (or $PROBE_BEARER) is required');
  }
  const mode = (args.mode ?? 'mcp') as ProbeMode;
  if (mode !== 'mcp' && mode !== 'tool') {
    throw new ConfigError(`--mode must be mcp or tool, got ${printable(args.mode ?? '')}`);
  }
  return {
    help: false,
    json: args.json === 'true',
    options: {
      baseUrl,
      bearer,
      mode,
      connections: count(args, 'connections'),
      concurrency: count(args, 'concurrency'),
      timeoutMs: count(args, 'timeout'),
      toolName: args.tool,
    },
  };
}
