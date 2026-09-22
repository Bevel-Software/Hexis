import { describe, it, expect, afterEach, vi } from 'vitest';
import { createConsoleLogger, logger, setLogger } from '../logging.js';
import type { ILogger, LogFields } from '../logger.contract.js';

/** A logger that records what reached it, bindings included. */
function capturing() {
  const lines: Array<{ level: string; message: string; fields?: LogFields; bindings: LogFields }> = [];
  const make = (bindings: LogFields): ILogger => ({
    debug: (message, fields) => void lines.push({ level: 'debug', message, fields, bindings }),
    info: (message, fields) => void lines.push({ level: 'info', message, fields, bindings }),
    warn: (message, fields) => void lines.push({ level: 'warn', message, fields, bindings }),
    error: (message, fields) => void lines.push({ level: 'error', message, fields, bindings }),
    child: (more) => make({ ...bindings, ...more }),
  });
  return { lines, logger: make({}) };
}

let restore: ILogger | null = null;
afterEach(() => {
  if (restore) setLogger(restore);
  restore = null;
  vi.restoreAllMocks();
});

describe('logger()', () => {
  it('routes through whatever is installed at the time of the call, not at the time of the lookup', () => {
    const log = logger('queue'); // obtained "at module load", before any root ran
    const cap = capturing();
    restore = setLogger(cap.logger);

    log.warn('behind', { rows: 3 });

    expect(cap.lines).toEqual([{ level: 'warn', message: 'behind', fields: { rows: 3 }, bindings: { module: 'queue' } }]);
  });

  it('a child carries its bindings on top of the module tag', () => {
    const cap = capturing();
    restore = setLogger(cap.logger);

    logger('workflow').child({ workspaceId: 'ws-1' }).info('pushed');

    expect(cap.lines[0]?.bindings).toEqual({ module: 'workflow', workspaceId: 'ws-1' });
  });
});

describe('createConsoleLogger', () => {
  it('writes the shape the backend has always written: [module] message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createConsoleLogger().child({ module: 'sync' }).warn('branch is behind');
    expect(warn).toHaveBeenCalledWith('[sync] branch is behind');
  });

  it('passes a lone error bare, so the console prints its stack', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = new Error('boom');
    createConsoleLogger({ module: 'mcp' }).error('session failed', { err });
    // Bare — the second argument IS an error, not an object holding one —
    // though a terminal-safe copy of it (see the escaping case below).
    expect(error).toHaveBeenCalledTimes(1);
    const [message, logged] = error.mock.calls[0] as [string, unknown];
    expect(message).toBe('[mcp] session failed');
    expect(logged).toBeInstanceOf(Error);
    expect((logged as Error).message).toBe('boom');
    expect((logged as Error).stack).toBe(err.stack);
  });

  /**
   * An error's MESSAGE is very often not the process's own text — git's
   * stderr, a path, a branch name — so it is made one line like any string
   * field; the frames are ours and keep their lines. The original is not
   * touched: it is often rethrown after it was logged.
   */
  it('escapes the text an error carries, keeps its frames, and never mutates the original', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = new Error('git said: fatal\n[forged] admin signed in\u009b31m');
    (err as Error & { code?: string }).code = 'E\nFORGED';
    createConsoleLogger({ module: 'sync' }).error('pull failed', { err });
    const logged = error.mock.calls[0]?.[1] as Error & { code?: string };
    expect(logged).toBeInstanceOf(Error);
    expect(logged).not.toBe(err);
    expect(logged.message).toBe('git said: fatal\\n[forged] admin signed in\\u009b31m');
    expect(logged.code).toBe('E\\nFORGED');
    // The header of the stack is the message and is escaped with it; the
    // frames below it are still lines of their own.
    expect(logged.stack?.startsWith('Error: git said: fatal\\n[forged] admin signed in\\u009b31m\n    at ')).toBe(true);
    expect(err.message).toBe('git said: fatal\n[forged] admin signed in\u009b31m');
    expect(err.stack?.includes('\n[forged]')).toBe(true);
  });

  /**
   * The frames are looked for after the stack's header — the error's own
   * `toString()` — not from the top: a message that carries a line shaped
   * like a frame must not move the boundary up and pass the rest of itself
   * through raw.
   */
  it('escapes a message that mimics a stack frame, whole', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = new Error('first\n    at fake (forged.js:1:1)\n[forged] admin signed in');
    createConsoleLogger({ module: 'sync' }).error('failed', { err });
    const logged = error.mock.calls[0]?.[1] as Error;
    expect(logged.message).toBe('first\\n    at fake (forged.js:1:1)\\n[forged] admin signed in');
    const header = logged.stack?.slice(0, logged.stack.indexOf('\n'));
    expect(header).toBe('Error: first\\n    at fake (forged.js:1:1)\\n[forged] admin signed in');
    // The frames that follow are the real ones; the forged one never became a line.
    expect(logged.stack?.slice(header!.length).startsWith('\n    at ')).toBe(true);
    expect(logged.stack?.includes('\n    at fake')).toBe(false);
  });

  it('escapes a string cause and the failures of an AggregateError, which the copy would otherwise drop', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const withStringCause = new Error('outer', { cause: 'git said\n[forged]' });
    const aggregate = new AggregateError([new Error('one\nA'), 'two\nB'], 'several');
    createConsoleLogger({ module: 'sync' }).error('failed', { err: withStringCause });
    createConsoleLogger({ module: 'sync' }).error('failed', { err: aggregate });
    const first = error.mock.calls[0]?.[1] as Error & { cause?: unknown };
    const second = error.mock.calls[1]?.[1] as AggregateError;
    expect(first.cause).toBe('git said\\n[forged]');
    expect(second).toBeInstanceOf(AggregateError);
    expect((second.errors[0] as Error).message).toBe('one\\nA');
    expect(second.errors[1]).toBe('two\\nB');
    // One failure listed twice is not a loop: both copies keep their text.
    const shared = new Error('same\nS');
    createConsoleLogger({ module: 'sync' }).error('failed', { err: new AggregateError([shared, shared], 'twice') });
    const third = error.mock.calls[2]?.[1] as AggregateError;
    expect(third.errors.map((e) => (e as Error).message)).toEqual(['same\\nS', 'same\\nS']);
    // An ordinary error's own enumerable `errors` field stays visible.
    const plain = Object.assign(new Error('plain'), { errors: ['x\ny'] });
    createConsoleLogger({ module: 'sync' }).error('failed', { err: plain });
    const fourth = error.mock.calls[3]?.[1] as Error & { errors: string[] };
    expect(Object.keys(fourth)).toContain('errors');
    expect(fourth.errors).toEqual(['x\\ny']);
  });

  it('cuts a cause chain that loops back on itself', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = new Error('a\nA');
    const b = new Error('b\nB', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    createConsoleLogger({ module: 'sync' }).error('failed', { err: a });
    const logged = error.mock.calls[0]?.[1] as Error & { cause?: Error & { cause?: unknown } };
    expect(logged.message).toBe('a\\nA');
    expect(logged.cause?.message).toBe('b\\nB');
    expect(logged.cause?.cause).toBe('[circular]');
  });

  it('passes several fields as one inspectable object, other bindings included', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createConsoleLogger({ module: 'cr', workspaceId: 'ws-1' }).info('merged', { number: 7 });
    expect(log).toHaveBeenCalledWith('[cr] merged', { workspaceId: 'ws-1', number: 7 });
  });

  /**
   * The property: whatever a message or a string field carries, the sink
   * writes one line. A newline is the forged-line case, U+009B the one-byte
   * escape that steers a terminal; both arrive routinely in text the process
   * did not write (a request's branch name, git's stderr).
   */
  it('keeps every event on one line, whatever the text carried', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createConsoleLogger({ module: 'sync' }).warn('branch "x\n[forged] admin signed in\u009b31m" is behind', {
      detail: 'line one\r\nline two',
      rows: 2,
    });
    expect(warn).toHaveBeenCalledWith('[sync] branch "x\\n[forged] admin signed in\\u009b31m" is behind', {
      detail: 'line one\\r\\nline two',
      rows: 2,
    });
  });

  it('maps levels onto the console method a reader expects', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sink = createConsoleLogger({ module: 'x' });
    sink.debug('d');
    sink.info('i');
    expect(debug).toHaveBeenCalledWith('[x] d');
    expect(log).toHaveBeenCalledWith('[x] i');
  });
});
