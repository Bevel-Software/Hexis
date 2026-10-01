import { describe, expect, it } from 'vitest';
import { ConfigError, count, FLAG_NAMES, parseArgs, parseCliRequest, USAGE } from '../first-call-probe.cli-args.js';

/**
 * What the probe CLI does with the words it is given.
 *
 * Two things are pinned here. First, that a flag the probe cannot honour is
 * REFUSED rather than reinterpreted: `--concurrency 0` would otherwise reach
 * `runPooled`'s `Math.max(1, …)` and produce a one-at-a-time run reported as
 * the fifty-wide burst that was asked for — a wrong number in a ticket log is
 * worse than no number. Second, that a flag value cannot forge the output: the
 * refusal is printed straight to a terminal or a CI log, and the value quoted
 * in it came from whoever typed the command.
 */
const REQUIRED = ['--base-url', 'https://core-staging.bevel.software', '--bearer', 'bevel_k'];
const env = {} as NodeJS.ProcessEnv;

/** The message alone — every refusal here is the message, not the stack. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a refusal, got none');
}

describe('parseArgs', () => {
  it('reads `--flag value` pairs and bare `--flag` switches', () => {
    expect(parseArgs(['--base-url', 'http://x', '--json', '--connections', '5'])).toEqual({
      'base-url': 'http://x',
      json: 'true',
      connections: '5',
    });
  });

  it('skips the conventional end-of-options separator, which some runners pass through', () => {
    // The documented invocation is `pnpm … probe:first-call -- --base-url …`.
    // pnpm normally eats the `--`; a runner that does not must not turn the
    // documented command into an error.
    expect(parseArgs(['--', '--tool', 'start_session'])).toEqual({ tool: 'start_session' });
  });

  it('refuses a mistyped flag instead of running the default probe behind it', () => {
    // The failure this prevents: `--concurency 1` was dropped and the default
    // fifty-wide burst ran, reported as the one-at-a-time run that was asked
    // for. A probe run is evidence, so a wrong number that looks right is the
    // worst thing it can produce.
    expect(refusal(() => parseArgs(['--base-url', 'http://x', '--concurency', '1']))).toBe(
      'unknown option "--concurency"',
    );
    expect(() => parseArgs(['--concurency', '1'])).toThrow(ConfigError);
  });

  it('refuses a stray word that belongs to no flag', () => {
    expect(refusal(() => parseArgs(['junk', '--tool', 'start_session']))).toMatch(/unexpected argument "junk"/);
  });

  it('refuses a value flag left without its value, rather than inventing one', () => {
    // `--bearer` with nothing after it became the literal bearer `"true"`: every
    // attempt came back 401 and the report read as fifty platform failures —
    // a reproduction of a bug that was never there.
    expect(refusal(() => parseArgs(['--base-url', 'http://x', '--bearer']))).toBe('--bearer needs a value');
    expect(refusal(() => parseArgs(['--bearer', '--json']))).toBe('--bearer needs a value');
    expect(refusal(() => parseArgs(['--tool']))).toBe('--tool needs a value');
  });

  it('lets a switch stand next to another flag without eating it', () => {
    expect(parseArgs(['--json', '--tool', 'ask'])).toEqual({ json: 'true', tool: 'ask' });
  });

  it('takes a negative value, leaving the range to the flag that owns it', () => {
    // `-5` is not `--something`, so it is this flag's value; `count` is what
    // says it is out of range, and it names the flag when it does.
    expect(parseArgs(['--timeout', '-5'])).toEqual({ timeout: '-5' });
  });

  it('escapes what it quotes back, so a mistyped flag cannot forge a log line', () => {
    const message = refusal(() => parseArgs(['--x\n  50/50 succeeded, 0 failed']));

    expect(message.split('\n')).toHaveLength(1);
    expect(message).toContain('\\n');
  });

  it('documents every flag it accepts', () => {
    // The table and the usage text are two lists of the same thing, and a flag
    // that exists but is undocumented is as good as absent to an operator.
    for (const name of FLAG_NAMES) {
      if (name === 'h') continue; // the one alias, deliberately not advertised
      expect(USAGE).toContain(`--${name}`);
    }
  });
});

describe('count', () => {
  it('leaves an absent flag undefined, so the probe keeps its own default', () => {
    expect(count({}, 'connections')).toBeUndefined();
  });

  it('accepts a positive integer', () => {
    expect(count({ connections: '50' }, 'connections')).toBe(50);
  });

  it.each(['0', '-5', '1.5', 'abc', '', 'Infinity', 'NaN'])('refuses %o rather than running something else', (raw) => {
    expect(() => count({ concurrency: raw }, 'concurrency')).toThrow(ConfigError);
    expect(refusal(() => count({ concurrency: raw }, 'concurrency'))).toMatch(
      /--concurrency must be a positive integer/,
    );
  });

  it('escapes the value it quotes back, so a flag cannot forge a log line', () => {
    // The message goes to stderr as-is. Unescaped, this value would print a
    // second line reading like a result the probe produced, and the escape
    // sequence would recolour everything after it.
    const message = refusal(() => count({ connections: 'x\n  50/50 succeeded, 0 failed[31m' }, 'connections'));

    expect(message.split('\n')).toHaveLength(1);
    expect(message).not.toContain('');
    // Escaped, not dropped: the operator still sees exactly what they typed.
    expect(message).toContain('\\n');
    expect(message).toContain('\\u001b[31m');
  });
});

describe('parseCliRequest', () => {
  it('asks for the usage text and nothing else', () => {
    expect(parseCliRequest(['--help'], env)).toEqual({ help: true });
    expect(parseCliRequest(['--h'], env)).toEqual({ help: true });
    expect(USAGE).toContain('--base-url');
  });

  it('turns the flags into the probe options, defaults left to the probe', () => {
    const request = parseCliRequest([...REQUIRED, '--connections', '50', '--mode', 'tool', '--json'], env);

    expect(request).toEqual({
      help: false,
      json: true,
      options: {
        baseUrl: 'https://core-staging.bevel.software',
        bearer: 'bevel_k',
        mode: 'tool',
        connections: 50,
        // Not defaulted here: `probeFirstCall` owns what absent means, so the
        // CLI and a programmatic caller cannot drift apart.
        concurrency: undefined,
        timeoutMs: undefined,
        toolName: undefined,
      },
    });
  });

  it('takes the bearer from the environment, so a key need not enter shell history', () => {
    const request = parseCliRequest(['--base-url', 'http://x'], { PROBE_BEARER: 'from-env' } as NodeJS.ProcessEnv);

    expect(request).toMatchObject({ help: false, options: { bearer: 'from-env' } });
  });

  it('names the one that is missing', () => {
    expect(refusal(() => parseCliRequest(['--bearer', 'k'], env))).toMatch(/--base-url is required/);
    expect(refusal(() => parseCliRequest(['--base-url', 'http://x'], env))).toMatch(
      /--bearer \(or \$PROBE_BEARER\) is required/,
    );
  });

  it('refuses a mode it does not have, with the value escaped', () => {
    expect(refusal(() => parseCliRequest([...REQUIRED, '--mode', 'grpc'], env))).toBe(
      '--mode must be mcp or tool, got "grpc"',
    );
    expect(refusal(() => parseCliRequest([...REQUIRED, '--mode', 'grpc\nFAKE'], env)).split('\n')).toHaveLength(1);
  });

  it('refuses a bad count before the probe is ever constructed', () => {
    expect(() => parseCliRequest([...REQUIRED, '--concurrency', '0'], env)).toThrow(ConfigError);
    expect(refusal(() => parseCliRequest([...REQUIRED, '--timeout', '-1'], env))).toMatch(
      /--timeout must be a positive integer/,
    );
  });
});
