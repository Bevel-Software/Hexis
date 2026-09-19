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

/** A numeric flag, or the default when absent. A garbage value is an error, not a silent default. */
function num(args: Record<string, string>, key: string, fallback: number | undefined): number | undefined {
  const raw = args[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number, got ${raw}`);
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(USAGE);
    return;
  }
  const baseUrl = args['base-url'];
  const bearer = args.bearer ?? process.env.PROBE_BEARER ?? '';
  if (!baseUrl || !bearer) {
    console.error(`${!baseUrl ? '--base-url is required' : '--bearer (or $PROBE_BEARER) is required'}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const mode = (args.mode ?? 'mcp') as ProbeMode;
  if (mode !== 'mcp' && mode !== 'tool') {
    console.error(`--mode must be mcp or tool, got ${args.mode}`);
    process.exitCode = 2;
    return;
  }
  const report = await probeFirstCall({
    baseUrl,
    bearer,
    mode,
    connections: num(args, 'connections', undefined),
    concurrency: num(args, 'concurrency', undefined),
    timeoutMs: num(args, 'timeout', undefined),
    toolName: args.tool,
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatProbeReport(report));
  if (report.failed > 0) process.exitCode = 1;
}

await main();
