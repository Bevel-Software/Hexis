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
export function createPinoLogger(opts: { level?: string; destination?: pino.DestinationStream } = {}): ILogger {
  const options: pino.LoggerOptions = {
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    serializers: { err: serializeError },
    base: { service: 'hexis' },
  };
  // A destination is a test's seam; the process itself writes to stdout.
  return wrap(opts.destination ? pino(options, opts.destination) : pino(options));
}

/**
 * What arrives under `err` is not always an Error: an unhandled rejection's
 * reason can be a string, an Error from another realm, or a bare object with
 * a `message` and a `stack` of its own. Those strings are escaped like any
 * other before pino's serializer sees them, so the shape does not decide
 * whether the text is made safe — and `message`/`stack`, which such objects
 * carry non-enumerably, are kept by name rather than lost with the rest.
 */
function asSafeError(err: unknown, seen: Set<object> = new Set()): Error {
  if (err instanceof Error) return oneLineError(err);
  if (typeof err === 'string') return new Error(oneLine(err));
  if (err && typeof err === 'object') {
    // Re-rooted on this realm's Error, so the one escaping rule applies to
    // it — header made one line, frames kept as lines — and pino's own
    // serializer recognises it as an error rather than a bag of fields.
    const source = err as Record<string, unknown>;
    const like = Object.create(Error.prototype) as Error & Record<string, unknown>;
    for (const [k, v] of Object.entries(source)) {
      if (k !== 'name' && k !== 'message' && k !== 'stack') like[k] = v;
    }
    for (const key of ['name', 'message', 'stack'] as const) {
      if (typeof source[key] === 'string') {
        Object.defineProperty(like, key, { value: source[key], enumerable: false, writable: true, configurable: true });
      }
    }
    // An AggregateError from another realm keeps its failures under a
    // non-enumerable `errors` too; carried by name, each failure first put
    // through this same re-rooting (a foreign Error inside is as foreign as
    // its parent), so `oneLineError` and pino then treat every one as an
    // error of this realm.
    if (Array.isArray(source.errors)) {
      // `seen` is the path down: a list that reaches itself, directly or
      // through a failure of its own, is cut where it loops — the same
      // answer `oneLineError` gives a cyclic cause.
      seen.add(source);
      const errors = source.errors.map((e) =>
        e && typeof e === 'object' ? (seen.has(e) ? '[circular]' : asSafeError(e, seen)) : e,
      );
      seen.delete(source);
      Object.defineProperty(like, 'errors', { value: errors, enumerable: false, writable: true, configurable: true });
    }
    return oneLineError(like);
  }
  return err as Error;
}

/**
 * pino's own error record, plus what that record leaves out: an
 * AggregateError's `errors` are non-enumerable and pino emits only message,
 * stack and the enumerable extras, so the failures it aggregates would
 * vanish from the log. Each is serialized the same way, nested.
 */
function serializeError(err: unknown): pino.SerializedError {
  const safe = asSafeError(err);
  const record = pino.stdSerializers.err(safe);
  const errors = (safe as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    (record as pino.SerializedError & { errors?: unknown[] }).errors = errors.map((e) =>
      e instanceof Error ? pino.stdSerializers.err(e) : e,
    );
  }
  return record;
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
