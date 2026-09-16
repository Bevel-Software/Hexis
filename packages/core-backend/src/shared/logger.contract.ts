/**
 * The contract for LOGGING. Nothing here writes anywhere — the one default
 * implementation is the console sink in `shared/logging.ts`, and a deployment's
 * shell installs whatever it runs in production (the server shell installs
 * pino). Modules never import a sink; they ask for a tagged logger and log.
 *
 * WHY A PORT. The backend logged through 294 bare `console.*` calls with no
 * level a filter could act on, no request or workspace a line could be
 * grouped by, and no shape a machine could parse. When something fails at
 * three in the morning the log cannot be reduced to one request or one
 * severity. A library would have fixed that in the published package — and
 * imposed a logging stack on every npm consumer, the enterprise overlay
 * included, which very likely logs its own way already; two loggers
 * interleaved is worse than either. So the package owns the contract and a
 * dependency-free default, and the shell that actually runs owns the choice.
 *
 * WHAT A LINE CARRIES. A message, for a person; fields, for a machine; and
 * the bindings of the logger it came from — at least `module`, the tag every
 * call used to spell by hand in square brackets. An error goes under `err`,
 * by that name: it is the key both the default sink and pino recognise as an
 * error, and render with its stack.
 */

export type LogFields = Record<string, unknown>;

export interface ILogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger whose every line also carries `bindings`. */
  child(bindings: LogFields): ILogger;
}
