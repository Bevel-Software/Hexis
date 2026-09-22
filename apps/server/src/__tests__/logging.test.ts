import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
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

  it('escapes a plain string reason', () => {
    const { lines, logger } = capture();
    logger.error('failed', { err: 'just text\n[forged]' });
    expect((lines()[0]?.err as { message: string }).message).toBe('just text\\n[forged]');
  });
});
