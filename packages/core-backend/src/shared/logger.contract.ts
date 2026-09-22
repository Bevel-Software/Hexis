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

/**
 * C0 and C1 control characters (U+009B among them: the one-byte CSI that
 * starts an ANSI sequence by itself) and the JS line separators. The rule
 * against control characters in a regex guards against accidental ones; these
 * are the point.
 */
const CONTROL_CHARS = new RegExp(`[\x00-\x1F\x7F-\x9F${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * `text` as one terminal-safe line. A message often carries text the process
 * did not write — a branch name from a request, a path from a plugin, git's
 * stderr — and written raw, a newline in it starts a forged line and an
 * escape sequence paints the terminal. Every sink applies this, so the rule
 * "one event, one line" is kept in one place rather than by each call site
 * remembering `printable`. Shared with the shell's sink through this contract
 * module because pino's JSON escapes only the C0 range: a C1 control or a
 * line separator would pass through it to the terminal that tails the log.
 */
export function oneLine(text: string): string {
  return text.replace(CONTROL_CHARS, (c) => NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * `err` with the text it carries made terminal-safe, its frames untouched.
 *
 * An error's message is very often not the process's own words: it quotes a
 * path, a branch name, git's stderr, a file's contents. Its stack frames ARE
 * the process's own and read best as the lines they are, so only the
 * message — and the head of the stack, which repeats it — is escaped. A
 * `cause` that is itself an error is treated the same way, since the console
 * prints it too (a chain that loops back on itself is cut where it loops).
 * The original is never mutated: an error is often rethrown or inspected
 * after it was logged.
 */
export function oneLineError(err: Error): Error {
  return escapedCopy(err, new Set());
}

function escapedCopy(err: Error, seen: Set<Error>): Error {
  seen.add(err);
  const message = oneLine(err.message);
  const copy = Object.create(Object.getPrototypeOf(err) as object) as Error & { cause?: unknown };
  Object.defineProperty(copy, 'message', { value: message, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(copy, 'name', { value: err.name, enumerable: false, writable: true, configurable: true });
  if (typeof err.stack === 'string') {
    // Node's stack is the error's own `toString()` — `<name>: <message>` —
    // followed by `\n    at …` frames. The frames are looked for AFTER that
    // header, not from the top: a message that itself holds a line shaped
    // like a frame would otherwise move the boundary up and pass the rest of
    // itself through raw. A stack that does not open with the header is not
    // one this code knows the shape of, and is escaped whole.
    // The frames keep their lines; each is still escaped within its line, for
    // a stack that is not Node's own (a foreign runtime's, a hand-built one)
    // and carries a control character after a frame-shaped line.
    const head = Error.prototype.toString.call(err);
    const frames = err.stack.startsWith(head) ? err.stack.indexOf('\n    at ', head.length) : -1;
    const stack =
      frames === -1
        ? oneLine(err.stack)
        : `${oneLine(err.stack.slice(0, frames))}\n${err.stack
            .slice(frames + 1)
            .split('\n')
            .map(oneLine)
            .join('\n')}`;
    Object.defineProperty(copy, 'stack', { value: stack, enumerable: false, writable: true, configurable: true });
  }
  const nested = (value: unknown): unknown =>
    value instanceof Error
      ? seen.has(value)
        ? '[circular]'
        : escapedCopy(value, seen)
      : typeof value === 'string'
        ? oneLine(value)
        : value;
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) {
    Object.defineProperty(copy, 'cause', { value: nested(cause), enumerable: false, writable: true, configurable: true });
  }
  // An `AggregateError`'s failures — non-enumerable there, and the whole
  // point of it; kept as enumerable as the source had it, so an ordinary
  // error that carries an `errors` list of its own still shows it.
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    Object.defineProperty(copy, 'errors', {
      value: errors.map(nested),
      enumerable: Object.prototype.propertyIsEnumerable.call(err, 'errors'),
      writable: true,
      configurable: true,
    });
  }
  // Own enumerable fields (a `code`, a `status`) travel with the error.
  for (const [key, value] of Object.entries(err)) {
    if (!(key in copy)) (copy as unknown as Record<string, unknown>)[key] = typeof value === 'string' ? oneLine(value) : value;
  }
  // `seen` is the path down, not everything met: one failure listed twice
  // under an AggregateError is copied twice, and only a true loop is cut.
  seen.delete(err);
  return copy;
}
