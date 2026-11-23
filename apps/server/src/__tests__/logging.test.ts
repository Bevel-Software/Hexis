import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import { createPinoLogger } from '../logging.js';

/** A pino logger writing JSON lines into memory, wrapped the way the shell wraps it. */
function capture(): { lines: () => Record<string, unknown>[]; logger: ReturnType<typeof createPinoLogger> } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const logger = createPinoLogger({ level: 'debug', destination: sink });
  return { lines: () => chunks.join('').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>), logger };
}

/**
 * The pino sink's `err` record: everything the console sink shows, as fields,
 * with the text made one line the same way — for an Error, for a reason that
 * is not one, and for an AggregateError whose failures pino alone would drop.
 */
describe('createPinoLogger — the err field', () => {
  it('serializes an AggregateError with its failures, each escaped', () => {
    const { lines, logger } = capture();
    logger.error('failed', { err: new AggregateError([new Error('one\nA'), 'two\nB'], 'several') });
    const err = lines()[0]?.err as { message: string; errors: unknown[] };
    expect(err.message).toBe('several');
    expect((err.errors[0] as { message: string }).message).toBe('one\\nA');
    expect(err.errors[1]).toBe('two\\nB');
  });

  it('keeps the message and stack of a reason that is not an Error, escaped', () => {
    const { lines, logger } = capture();
    const foreign = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(foreign, 'name', { value: 'Foreign', enumerable: false });
    Object.defineProperty(foreign, 'message', { value: 'boom\n[forged]', enumerable: false });
    Object.defineProperty(foreign, 'stack', { value: 'Foreign: boom\n[forged]\n    at x (y:1:1)', enumerable: false });
    foreign.code = 'E\nX';
    logger.error('failed', { err: foreign });
    const err = lines()[0]?.err as { message: string; stack: string; code: string };
    expect(err.message).toBe('boom\\n[forged]');
    expect(err.stack).toBe('Foreign: boom\\n[forged]\n    at x (y:1:1)');
    expect(err.code).toBe('E\\nX');
  });

  it('keeps the failures of an AggregateError from another realm, escaped', () => {
    const { lines, logger } = capture();
    const foreign = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(foreign, 'name', { value: 'AggregateError', enumerable: false });
    Object.defineProperty(foreign, 'message', { value: 'several', enumerable: false });
    // One failure is itself from the other realm: no `Error` prototype, its
    // message and stack non-enumerable.
    const foreignInner = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(foreignInner, 'name', { value: 'Error', enumerable: false });
    Object.defineProperty(foreignInner, 'message', { value: 'three\nC', enumerable: false });
    Object.defineProperty(foreignInner, 'stack', { value: 'Error: three\nC\n    at z (w:1:1)', enumerable: false });
    Object.defineProperty(foreign, 'errors', {
      value: [new Error('one\nA'), 'two\nB', foreignInner],
      enumerable: false,
    });
    logger.error('failed', { err: foreign });
    const err = lines()[0]?.err as { message: string; errors: unknown[] };
    expect(err.message).toBe('several');
    expect((err.errors[0] as { message: string }).message).toBe('one\\nA');
    expect(err.errors[1]).toBe('two\\nB');
    expect((err.errors[2] as { message: string; stack: string }).message).toBe('three\\nC');
    expect((err.errors[2] as { message: string; stack: string }).stack).toBe('Error: three\\nC\n    at z (w:1:1)');
  });

  it('cuts a foreign failure list that reaches itself, instead of recursing forever', () => {
    const { lines, logger } = capture();
    const foreign = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(foreign, 'message', { value: 'loops', enumerable: false });
    const inner = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(inner, 'message', { value: 'inner', enumerable: false });
    Object.defineProperty(inner, 'errors', { value: [foreign], enumerable: false });
    // `inner` is listed twice: a repeat on the same level is not a loop, and
    // keeps its text both times — only the path back up is cut.
    Object.defineProperty(foreign, 'errors', { value: [foreign, inner, inner], enumerable: false });
    logger.error('failed', { err: foreign });
    const err = lines()[0]?.err as { message: string; errors: unknown[] };
    expect(err.message).toBe('loops');
    expect(err.errors[0]).toBe('[circular]');
    for (const nested of [err.errors[1], err.errors[2]] as { message: string; errors: unknown[] }[]) {
      expect(nested.message).toBe('inner');
      expect(nested.errors[0]).toBe('[circular]');
    }
  });

  it('escapes a plain string reason', () => {
    const { lines, logger } = capture();
    logger.error('failed', { err: 'just text\n[forged]' });
    expect((lines()[0]?.err as { message: string }).message).toBe('just text\\n[forged]');
  });
});

/**
 * Logging a timeout or an abort never fails the call that logged it. The
 * errors are the real ones — what `fetch` rejects with when its
 * `AbortSignal.timeout` fires or its `AbortController` aborts — and pino's
 * own error serializer lists every key of what it is handed, inherited ones
 * included. On 2026-11-23 that listing reached DOMException's `code` getter
 * on the escaped copy and threw `Value of "this" must be of DOMException`
 * out of the caller's `catch`.
 */
describe('createPinoLogger — timeouts and aborts', () => {
  let server: Server;
  let url = '';
  beforeAll(async () => {
    server = createServer(() => undefined); // accepts, never answers
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const rejectionOf = async (run: () => Promise<unknown>): Promise<Error> => {
    try {
      await run();
    } catch (err) {
      return err as Error;
    }
    throw new Error('expected the call to reject');
  };
  const realTimeout = () => rejectionOf(() => fetch(url, { signal: AbortSignal.timeout(20) }));
  const realAbort = () =>
    rejectionOf(() => {
      const controller = new AbortController();
      const pending = fetch(url, { signal: controller.signal });
      controller.abort();
      return pending;
    });
  type Rec = { type: string; name?: string; message: string; stack: string; code?: number; errors?: Rec[] };

  it('writes one record for a real timeout and a real abort, with type, name, message and stack', async () => {
    const { lines, logger } = capture();
    const timeout = await realTimeout();
    const abort = await realAbort();
    expect(timeout).toBeInstanceOf(DOMException);
    expect(abort).toBeInstanceOf(DOMException);
    expect(() => logger.warn('catalog-revision loopback threw:', { err: timeout })).not.toThrow();
    expect(() => logger.error('skill get_skill loopback threw:', { err: abort })).not.toThrow();
    const [first, second] = lines();
    expect(lines()).toHaveLength(2);
    expect(first?.msg).toBe('catalog-revision loopback threw:');
    expect(first?.err).toMatchObject({ type: 'DOMException', name: 'TimeoutError', message: timeout.message, code: 23 });
    expect((first?.err as Rec).stack.startsWith(`TimeoutError: ${timeout.message}`)).toBe(true);
    expect(second?.err).toMatchObject({ type: 'DOMException', name: 'AbortError', message: abort.message, code: 20 });
    expect((second?.err as Rec).stack).toContain('AbortError');
  });

  it('holds when the DOMException is a cause, and when it is among an AggregateError`s failures', async () => {
    const { lines, logger } = capture();
    const timeout = await realTimeout();
    const abort = await realAbort();
    expect(() => logger.error('loopback threw:', { err: new Error('all-tools loopback', { cause: timeout }) })).not.toThrow();
    expect(() => logger.error('several threw:', { err: new AggregateError([abort, timeout], 'both') })).not.toThrow();
    const [caused, aggregate] = lines().map((l) => l.err as Rec);
    expect(caused?.message).toBe(`all-tools loopback: ${timeout.message}`);
    expect(caused?.stack).toContain('caused by: TimeoutError');
    expect(aggregate?.errors?.map((e) => [e.type, e.name, e.message])).toEqual([
      ['DOMException', 'AbortError', abort.message],
      ['DOMException', 'TimeoutError', timeout.message],
    ]);
  });

  it('never throws into its caller: a record pino cannot make becomes a plain record saying why', () => {
    const { lines, logger } = capture();
    const fields = {
      get detail(): string {
        throw new TypeError('this field refuses to be read');
      },
    };
    expect(() => logger.error('skill list_skills loopback threw:', fields)).not.toThrow();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      level: 50,
      msg: 'skill list_skills loopback threw: [the log record could not be serialized: TypeError: this field refuses to be read]',
    });
  });

  it('never throws into its caller when the value pino stringifies refuses', () => {
    const { lines, logger } = capture();
    const refusing = {
      toJSON(): never {
        throw new Error('cannot be written as JSON');
      },
    };
    expect(() => logger.info('wrote', { refusing })).not.toThrow();
    expect(lines()[0]?.msg).toBe('wrote [the log record could not be serialized: Error: cannot be written as JSON]');
  });
});
