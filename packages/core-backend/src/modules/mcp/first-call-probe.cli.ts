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
 * not only read; 2 when the command itself was wrong. `--json` prints the
 * whole report, every attempt included, for a run whose numbers want keeping
 * rather than summarizing.
 *
 * What to run and whether the flags make sense is decided in
 * `first-call-probe.cli-args.ts`, where it can be tested. All that is left
 * here is the part that cannot be: reading argv, printing, and the exit code.
 */
import { probeFirstCall, formatProbeReport, ProbeOptionsError } from './first-call-probe.js';
import { ConfigError, parseCliRequest, USAGE } from './first-call-probe.cli-args.js';
import { terminalSafeJson } from '../../shared/printable.js';

async function main(): Promise<void> {
  const request = parseCliRequest(process.argv.slice(2));
  if (request.help) {
    console.log(USAGE);
    return;
  }
  // `probeFirstCall` checks the arguments it cannot probe with — a malformed
  // `--base-url` above all — and does it before opening anything, so its
  // refusal is the operator's typo too and leaves by the same door as the
  // rest. ONLY that refusal: anything else it throws is the probe crashing,
  // which must not come out dressed as a mistyped command.
  const report = await probeFirstCall(request.options).catch((err: unknown) => {
    throw err instanceof ProbeOptionsError ? new ConfigError(err.message) : err;
  });
  // The report quotes what the remote said, so the JSON is made terminal-safe
  // the way every other operator-facing text is (see `terminalSafeJson`).
  console.log(request.json ? terminalSafeJson(JSON.stringify(report, null, 2)) : formatProbeReport(report));
  if (report.failed > 0) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  // Every way of mis-invoking this ends the same way: the sentence that says
  // what to fix, the usage block, exit 2. A bad flag used to escape the
  // top-level `await` as an unhandled rejection — a stack trace and exit 1,
  // which reads like the probe crashed rather than like the command was typed
  // wrong. A real crash still looks like one: exit 1, no usage block
  // pretending the operator mistyped something.
  if (err instanceof ConfigError) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
}
