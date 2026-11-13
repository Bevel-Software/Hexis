import { describe, expect, it } from 'vitest';
import { capturingLogger } from '../../__tests__/capturing-logger.js';
import { callFireAndForget } from '../fire-and-forget.js';

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
const FAILED = 'a listener failed:';

describe('callFireAndForget — nothing a listener does reaches the caller', () => {
  it('a listener that throws is logged as failed, and the call returns', () => {
    const { logger, lines } = capturingLogger();
    expect(() =>
      callFireAndForget(
        () => {
          throw new Error('reactor exploded');
        },
        'event',
        logger,
        FAILED,
      ),
    ).not.toThrow();
    expect(lines).toEqual([{ level: 'error', message: FAILED, fields: { err: expect.objectContaining({ message: 'reactor exploded' }) } }]);
  });

  it('a listener whose promise rejects is logged as failed — a rejection the try/catch alone would miss', async () => {
    const { logger, lines } = capturingLogger();
    callFireAndForget(async () => Promise.reject(new Error('reactor exploded later')), 'event', logger, FAILED);
    expect(lines).toEqual([]);
    await settled();
    expect(lines).toEqual([{ level: 'error', message: FAILED, fields: { err: expect.objectContaining({ message: 'reactor exploded later' }) } }]);
  });

  it('a listener that returns, or whose promise resolves, logs nothing', async () => {
    const { logger, lines } = capturingLogger();
    callFireAndForget(() => undefined, 'event', logger, FAILED);
    callFireAndForget(async () => undefined, 'event', logger, FAILED);
    await settled();
    expect(lines).toEqual([]);
  });
});
