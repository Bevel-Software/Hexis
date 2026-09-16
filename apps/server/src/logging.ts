import pino, { type Logger as Pino } from 'pino';
import type { ILogger, LogFields } from '@bevel-software/platform-core-backend/shared/logger.contract.js';

/**
 * pino as the process's logger: one JSON object per line on stdout, with a
 * level, a time, the module the line came from, and whatever fields the call
 * carried — the shape a log pipeline filters and groups by.
 *
 * Here and not in the published package, by decision: the package owns the
 * contract and a dependency-free default, the shell that runs owns the
 * choice, and npm consumers inherit nothing. What pino brings that the
 * default does not is the part that matters under load: writes go through
 * its own async stream rather than a blocking `process.stdout.write`, so a
 * full pipe — which is what stdout is under Docker's json-file driver —
 * cannot stall the event loop.
 *
 * `err` serializes through pino's standard error serializer, so a thrown
 * error arrives as `{ type, message, stack }` rather than `{}`.
 */
export function createPinoLogger(opts: { level?: string } = {}): ILogger {
  return wrap(
    pino({
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      serializers: { err: pino.stdSerializers.err },
      base: { service: 'hexis' },
    }),
  );
}

function wrap(instance: Pino): ILogger {
  const emit =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, fields?: LogFields): void => {
      if (fields) instance[level](fields, message);
      else instance[level](message);
    };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (bindings) => wrap(instance.child(bindings)),
  };
}
