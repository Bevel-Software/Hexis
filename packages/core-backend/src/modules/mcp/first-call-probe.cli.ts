/**
 * Command-line front end for {@link probeFirstCall} — the reproduction this
 * ticket's log is written from. Nothing imports this file; it exists to be run:
 *
 *   pnpm --filter @bevel-software/platform-core-backend probe:first-call \
 *     -- --base-url https://core-staging.bevel.software --bearer bevel_…
 *
 * The bearer may come from `--bearer` or from `PROBE_BEARER`, so a throwaway
 * connection key does not have to be typed into a shell history.
 *
 * Exit code is 1 when any attempt failed, so a run can be used as a check and
 * not only read. `--json` prints the whole report, every attempt included, for
 * a run whose numbers want keeping rather than summarizing.
 */
import { probeFirstCall, formatProbeReport, type ProbeMode } from './first-call-probe.js';

const USAGE = `probe-first-call — fresh connections, one first start_session call each

  --base-url <url>      deployment root, e.g. https://core-staging.bevel.software (required)
  --bearer <token>      connection key or bearer; defaults to $PROBE_BEARER
  --connections <n>     fresh connections to open (default 50)
  --concurrency <n>     attempts in flight (default: all of them, one burst)
  --mode <mcp|tool>     mcp: full client path (default); tool: plain POST, no transport
  --tool <name>         tool to call (default start_session)
  --timeout <ms>        per-request ceiling (default 30000)
  --json                print the full report as JSON instead of the log block
`;

/** `--flag value` pairs plus bare `--flag` switches, with no dependency. */
function parseArgs(argv: readonly string[]): Record<string, string> {
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
 * out-of-range are both refused here, before anything is opened.
 */
function count(args: Record<string, string>, key: string): number | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`--${key} must be a positive integer, got ${raw}`);
  }
  return parsed;
}

/** An argument the operator has to fix: printed plainly, exit 2, no stack. */
class ConfigError extends Error {}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(USAGE);
    return;
  }
  const baseUrl = args['base-url'];
  const bearer = args.bearer ?? process.env.PROBE_BEARER ?? '';
  if (!baseUrl || !bearer) {
    throw new ConfigError(!baseUrl ? '--base-url is required' : '--bearer (or $PROBE_BEARER) is required');
  }
  const mode = (args.mode ?? 'mcp') as ProbeMode;
  if (mode !== 'mcp' && mode !== 'tool') {
    throw new ConfigError(`--mode must be mcp or tool, got ${args.mode}`);
  }
  const options = {
    baseUrl,
    bearer,
    mode,
    connections: count(args, 'connections'),
    concurrency: count(args, 'concurrency'),
    timeoutMs: count(args, 'timeout'),
    toolName: args.tool,
  };
  // `probeFirstCall` checks the arguments it cannot probe with — a malformed
  // `--base-url` above all — and does it before opening anything. Those are
  // the operator's typos too, so they leave by the same door.
  const report = await probeFirstCall(options).catch((err: unknown) => {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatProbeReport(report));
  if (report.failed > 0) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  // Every way of mis-invoking this ends the same way: the sentence that says
  // what to fix, the usage block, exit 2. A bad flag used to escape the
  // top-level `await` as an unhandled rejection — a stack trace and exit 1,
  // which reads like the probe crashed rather than like the command was typed
  // wrong. A real crash still looks like one: stack, exit 1, no usage block
  // pretending the operator mistyped something.
  if (err instanceof ConfigError) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
}
