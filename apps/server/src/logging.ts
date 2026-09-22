import pino, { type Logger as Pino } from 'pino';
import {
  oneLine,
  oneLineError,
  type ILogger,
  type LogFields,
} from '@bevel-software/platform-core-backend/shared/logger.contract.js';

/**
 * pino as the process's logger: one JSON object per line on stdout, with a
 * level, a time, the module the line came from, and whatever fields the call
 * carried — the shape a log pipeline filters and groups by.
 *
 * Here and not in the published package, by decision: the package owns the
 * contract and a dependency-free default, the shell that runs owns the
 * choice, and npm consumers inherit nothing. pino's default destination is
 * asynchronous (a sonic-boom with `sync: false`), but pino registers an exit
 * hook for it that flushes synchronously, so a fatal line written just before
 * `process.exit` still reaches stdout; nothing here needs a flush of its own.
 *
 * `err` serializes through pino's standard error serializer, so a thrown
 * error arrives as `{ type, message, stack }` rather than `{}`.
 *
 * Messages, string fields and an error's message are made one line first
 * (`oneLine`, shared with the default sink). JSON escapes the C0 controls by
 * construction, but not the C1 range or the line separators: a U+009B in a
 * branch name would pass through the JSON to whatever terminal tails the
 * log, and `docker logs` is such a terminal.
 */
export function createPinoLogger(opts: { level?: string } = {}): ILogger {
  return wrap(
    pino({
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      serializers: { err: (err: unknown) => pino.stdSerializers.err(err instanceof Error ? oneLineError(err) : (err as Error)) },
      base: { service: 'hexis' },
    }),
  );
}

function wrap(instance: Pino): ILogger {
  const safe = (fields: LogFields): LogFields =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [
        k,
        typeof v === 'string' ? oneLine(v) : v instanceof Error && k !== 'err' ? oneLineError(v) : v,
      ]),
    );
  const emit =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, fields?: LogFields): void => {
      if (fields) instance[level](safe(fields), oneLine(message));
      else instance[level](oneLine(message));
    };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (bindings) => wrap(instance.child(safe(bindings))),
  };
}
