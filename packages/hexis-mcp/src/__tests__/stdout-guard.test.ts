import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Importing the module is the act under test: it replaces this worker's console.
import '../stdout-guard.js';

describe('stdout guard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends every console method to stderr and leaves stdout to the protocol', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Everything a dependency might log with — the stdout-bound methods
    // included, not only `log`.
    console.log('log');
    console.info('info');
    console.debug('debug');
    console.warn('warn');
    console.error('error');
    console.dir({ dir: 1 });
    console.table([{ table: 1 }]);
    console.count('count');
    console.time('timer');
    console.timeEnd('timer');
    console.group('group');
    console.groupEnd();
    console.trace('trace');

    expect(out).not.toHaveBeenCalled();
    const written = err.mock.calls.map((call) => String(call[0])).join('');
    for (const word of ['log', 'info', 'debug', 'warn', 'error', 'dir: 1', 'table', 'count: 1', 'timer: ', 'group', 'trace']) {
      expect(written).toContain(word);
    }

    // The protocol's own writes are untouched.
    process.stdout.write('{"jsonrpc":"2.0"}\n');
    expect(out).toHaveBeenCalledTimes(1);
  });

  it('keeps console.Console, so a dependency can still build a console of its own', () => {
    expect(typeof console.Console).toBe('function');
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    });
    const own = new console.Console(sink);
    own.log('mine');
    expect(chunks.join('')).toContain('mine');
  });
});
