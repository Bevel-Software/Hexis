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
    expect(error).toHaveBeenCalledWith('[mcp] session failed', err);
  });

  it('passes several fields as one inspectable object, other bindings included', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createConsoleLogger({ module: 'cr', workspaceId: 'ws-1' }).info('merged', { number: 7 });
    expect(log).toHaveBeenCalledWith('[cr] merged', { workspaceId: 'ws-1', number: 7 });
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
