import { createServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createConsoleLogger, logger, setLogger } from '../logging.js';
import { oneLineError, type ILogger, type LogFields } from '../logger.contract.js';

/**
 * Logging a timeout or an abort never fails the call that logged it.
 *
 * The errors here are the real ones: the rejection of a `fetch` whose
 * `AbortSignal.timeout` fired, and of one whose `AbortController` aborted —
 * both `DOMException`s, whose prototype carries an enumerable `code` getter
 * that refuses any receiver the platform did not build. On 2026-11-23 the
 * escaped copy the sinks log tripped that getter and every MCP tool call
 * answered `Value of "this" must be of DOMException`.
 */

let server: Server;
let url = '';
beforeAll(async () => {
  // Accepts a request and never answers it: a hung loopback.
  server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function rejectionOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the call to reject');
}

/** What `fetch` rejects with when its `AbortSignal.timeout` fires. */
const realTimeout = () => rejectionOf(() => fetch(url, { signal: AbortSignal.timeout(20) }));
/** What `fetch` rejects with when its `AbortController` aborts it. */
const realAbort = () =>
  rejectionOf(() => {
    const controller = new AbortController();
    const pending = fetch(url, { signal: controller.signal });
    controller.abort();
    return pending;
  });

/** Every way a sink or a person reads an error: field by field, listed, inspected. */
function readEverything(err: object): void {
  for (const key in err) void (err as Record<string, unknown>)[key];
  void Object.entries(err);
  void JSON.stringify(Object.entries(err));
  void inspect(err, { showHidden: true, depth: 5 });
  for (let o: object | null = err; o !== null; o = Object.getPrototypeOf(o) as object | null) {
    for (const key of Reflect.ownKeys(o)) void (err as Record<PropertyKey, unknown>)[key];
  }
}

let restore: ILogger | null = null;
afterEach(() => {
  if (restore) setLogger(restore);
  restore = null;
  vi.restoreAllMocks();
});

describe('the errors under test are the real ones', () => {
  it('a fired AbortSignal.timeout and an aborted AbortController reject fetch with DOMExceptions', async () => {
    const timeout = await realTimeout();
    const abort = await realAbort();
    expect(timeout).toBeInstanceOf(DOMException);
    expect(timeout.name).toBe('TimeoutError');
    expect(abort).toBeInstanceOf(DOMException);
    expect(abort.name).toBe('AbortError');
  });
});

describe('oneLineError — a copy every reader can read', () => {
  it('a timeout and an abort copy can be read field by field and enumerated', async () => {
    for (const err of [await realTimeout(), await realAbort()]) {
      const copy = oneLineError(err);
      expect(() => readEverything(copy)).not.toThrow();
      // Still the class it was, with the values the real one answers.
      expect(copy).toBeInstanceOf(DOMException);
      expect(copy.name).toBe(err.name);
      expect(copy.message).toBe(err.message);
      expect((copy as DOMException).code).toBe((err as DOMException).code);
      // As listed as the real one: a serializer that walks keys finds the same.
      const keys = (o: object) => {
        const out: string[] = [];
        for (const k in o) out.push(k);
        return out.sort();
      };
      expect(keys(copy)).toEqual(keys(err));
    }
  });

  it('holds for a DOMException under `cause` and among an AggregateError`s `errors`', async () => {
    const timeout = await realTimeout();
    const abort = await realAbort();
    const caused = new Error('loopback threw', { cause: timeout });
    const aggregate = new AggregateError([abort, timeout], 'both failed');
    const causedCopy = oneLineError(caused) as Error & { cause: DOMException };
    const aggregateCopy = oneLineError(aggregate) as AggregateError;
    expect(() => readEverything(causedCopy)).not.toThrow();
    expect(() => readEverything(causedCopy.cause)).not.toThrow();
    expect(causedCopy.cause.name).toBe('TimeoutError');
    for (const e of aggregateCopy.errors as object[]) expect(() => readEverything(e)).not.toThrow();
    expect((aggregateCopy.errors as Error[]).map((e) => e.name)).toEqual(['AbortError', 'TimeoutError']);
  });

  /**
   * The rule is about accessors that check their receiver, whatever class
   * defines them: here a getter behind a `#private` field (enumerable, as a
   * platform class's are) and a plain class getter. Neither is a DOMException.
   */
  it('holds for any error whose prototype has a receiver-checking accessor', () => {
    class Branded extends Error {
      #status = 503;
      get status(): number {
        return this.#status;
      }
      get detail(): string {
        return `status ${this.#status}\nforged`;
      }
    }
    Object.defineProperty(Branded.prototype, 'status', { enumerable: true });
    const err = new Branded('upstream refused');
    const copy = oneLineError(err) as Branded;
    expect(() => readEverything(copy)).not.toThrow();
    expect(copy.status).toBe(503);
    expect(copy.detail).toBe('status 503\\nforged');
    expect(Object.keys(copy)).toContain('status');
    // A getter that refuses even the original leaves nothing to throw on the copy.
    class Refusing extends Error {
      get broken(): never {
        throw new Error('refuses everyone');
      }
    }
    const refusing = oneLineError(new Refusing('x'));
    expect(() => readEverything(refusing)).not.toThrow();
    expect((refusing as Refusing).broken).toBeUndefined();
  });

  it('keeps its guarantees for a DOMException: one-line head, frames as lines, original untouched, loops cut', async () => {
    const timeout = await realTimeout();
    const stackBefore = timeout.stack;
    const forged = new DOMException('refused\n[forged] admin signed in\u009b31m', 'TimeoutError');
    const copy = oneLineError(forged);
    expect(copy.message).toBe('refused\\n[forged] admin signed in\\u009b31m');
    expect(copy.stack?.startsWith('TimeoutError: refused\\n[forged] admin signed in\\u009b31m\n    at ')).toBe(true);
    expect(forged.message).toBe('refused\n[forged] admin signed in\u009b31m');
    // A loop through a DOMException's own `cause` is cut where it loops.
    const outer = new Error('outer', { cause: timeout });
    Object.defineProperty(timeout, 'cause', { value: outer, configurable: true });
    const looped = oneLineError(outer) as Error & { cause: Error & { cause: unknown } };
    expect(looped.cause.name).toBe('TimeoutError');
    expect(looped.cause.cause).toBe('[circular]');
    expect(timeout.stack).toBe(stackBefore);
  });
});

describe('the default console sink', () => {
  it('logs a real timeout and a real abort, bare or nested, with type, message and stack, and does not throw', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const timeout = await realTimeout();
    const abort = await realAbort();
    const log = logger('mcp'); // the default sink: nothing installed
    const errs: Error[] = [timeout, abort, new Error('wrapped', { cause: timeout }), new AggregateError([abort], 'agg')];
    for (const err of errs) expect(() => log.error('loopback threw:', { err })).not.toThrow();
    expect(error).toHaveBeenCalledTimes(errs.length);
    const printed = error.mock.calls.map((call) => {
      expect(() => readEverything(call[1] as object)).not.toThrow();
      return inspect(call[1]);
    });
    expect(printed[0]).toContain('TimeoutError');
    expect(printed[0]).toContain(timeout.message);
    expect(printed[0]).toContain('    at ');
    expect(printed[1]).toContain('AbortError');
    expect(printed[1]).toContain(abort.message);
    expect(printed[2]).toContain('TimeoutError');
    expect(printed[3]).toContain('AbortError');
  });

  it('never throws into its caller: a record that cannot be made becomes a plain line saying why', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fields = {
      get detail(): string {
        throw new TypeError('this field refuses to be read');
      },
    } as LogFields;
    expect(() => createConsoleLogger({ module: 'mcp' }).error('skill get_skill loopback threw:', fields)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual([
      '[mcp] skill get_skill loopback threw: [the log record could not be serialized: TypeError: this field refuses to be read]',
    ]);
  });
});

describe('logger() — whatever sink is installed', () => {
  it('a sink that throws writes a plain record instead and the call returns', async () => {
    const lines: Array<{ message: string; fields?: LogFields }> = [];
    const throwing = (): ILogger => ({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      // Throws on any record carrying fields, as a serializer that cannot
      // read one does; writes a plain one.
      error: (message, fields) => {
        if (fields) throw new TypeError('Value of "this" must be of DOMException');
        lines.push({ message });
      },
      child: () => throwing(),
    });
    restore = setLogger(throwing());
    const err = await realTimeout();
    expect(() => logger('mcp').error('skill list_skills loopback threw:', { err })).not.toThrow();
    expect(lines).toEqual([
      {
        message:
          'skill list_skills loopback threw: [the log record could not be serialized: TypeError: Value of "this" must be of DOMException]',
      },
    ]);
  });

  it('the plain record is one terminal-safe line even when the failed sink does not escape', async () => {
    const lines: string[] = [];
    // A sink that writes the message raw and throws on any record with fields.
    const raw = (): ILogger => ({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message, fields) => {
        if (fields) throw new TypeError('Value of "this" must be of DOMException');
        lines.push(message);
      },
      child: () => raw(),
    });
    restore = setLogger(raw());
    const err = await realTimeout();
    const forged = `branch x\n[mcp] forged line \u001b[31mred\u009b2J\u2028end`;
    expect(() => logger('mcp').error(forged, { err })).not.toThrow();
    expect(lines).toEqual([
      'branch x\\n[mcp] forged line \\u001b[31mred\\u009b2J\\u2028end [the log record could not be serialized: TypeError: Value of "this" must be of DOMException]',
    ]);
  });

  it('a sink that cannot write even the plain record still returns', () => {
    const broken: ILogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => {
        throw new Error('stdout is gone');
      },
      child: () => broken,
    };
    restore = setLogger(broken);
    expect(() => logger('mcp').error('anything', { rows: 1 })).not.toThrow();
  });

  it('a child that cannot be made still logs, through the parent, and says why', () => {
    const lines: string[] = [];
    const parent: ILogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => void lines.push(message),
      error: (message) => void lines.push(message),
      child: () => {
        throw new Error('bindings refused');
      },
    };
    restore = setLogger(parent);
    expect(() => logger('mcp').error('failed')).not.toThrow();
    expect(lines).toEqual([
      'a child logger could not be made; logging without its bindings: Error: bindings refused',
      'failed',
    ]);
  });
});
