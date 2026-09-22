// This file IS the console sink; every other file logs through it. The lint
// rule that forbids `console` elsewhere in the backend exempts exactly this
// file (see eslint.config.js).
import { oneLine, oneLineError, type ILogger, type LogFields } from './logger.contract.js';

/**
 * Where the backend's logging goes, and how a module gets a logger.
 *
 * ONE SLOT, INSTALLED ONCE. The composition root — or a shell before it —
 * calls {@link setLogger} with the implementation the process runs on, and
 * every module obtains a tagged child through {@link logger}. The slot is
 * process-wide on purpose: the `console` it replaces was, and threading a
 * logger through some sixty constructors (and the several hundred places
 * tests construct them) would spend a great deal to make a cross-cutting
 * concern look like a per-object dependency. It remains injectable: a suite
 * that wants to see what was logged installs a capturing logger through the
 * same setter.
 *
 * CHILDREN RESOLVE LATE. `logger('tag')` is called at module load, before any
 * root has run, so what it returns is a handle that looks the slot up on
 * every call rather than a child of whatever happened to be installed then.
 * Installing pino after a module loaded therefore still routes that module's
 * lines through pino.
 */

let current: ILogger = createConsoleLogger();

/** Install the process's logger. Returns the previous one, for a suite to restore. */
export function setLogger(impl: ILogger): ILogger {
  const previous = current;
  current = impl;
  return previous;
}

/**
 * The logger a module logs through, carrying `module: tag` on every line — the
 * `[tag]` every call used to spell by hand.
 */
export function logger(tag: string): ILogger {
  return lateBound({ module: tag });
}

function lateBound(bindings: LogFields): ILogger {
  return {
    debug: (message, fields) => current.child(bindings).debug(message, fields),
    info: (message, fields) => current.child(bindings).info(message, fields),
    warn: (message, fields) => current.child(bindings).warn(message, fields),
    error: (message, fields) => current.child(bindings).error(message, fields),
    child: (more) => lateBound({ ...bindings, ...more }),
  };
}

/**
 * The default sink: `console`, in the shape the backend has always written —
 * `[module] message`, and the fields after it. Dependency-free, so the
 * published package logs sensibly with nothing installed, and human-shaped,
 * because a terminal is where that case is read. A deployment that wants
 * machine-shaped lines installs a sink that emits them; the server shell
 * installs pino.
 *
 * Fields are passed to `console` as a second argument rather than folded into
 * the string, so an object stays inspectable and an error keeps its stack.
 * When `err` is the only field it is passed bare: that is the shape a person
 * at a terminal wants, and the shape the suites that watch the console have
 * always asserted on.
 *
 * An error field is passed as a copy whose message is one line (see
 * `oneLineError`): the stack the console prints is the process's own text,
 * but the message at its head is very often not — it quotes git's stderr, a
 * path, a request's branch name — and unescaped it would forge a line or
 * paint the terminal exactly as a string field would. Every call site that
 * logs `{ err }` is covered here, so none of them has to remember it.
 */
export function createConsoleLogger(bindings: LogFields = {}): ILogger {
  // The tag is a binding like any other and goes through the same rule: a
  // module name is the code's own today, but the contract lets a caller bind
  // one, and a tag is written at the head of every line it tags.
  const prefix = typeof bindings.module === 'string' ? `[${oneLine(bindings.module)}] ` : '';
  const rest = Object.fromEntries(Object.entries(bindings).filter(([k]) => k !== 'module'));
  const safe = (v: unknown): unknown => (typeof v === 'string' ? oneLine(v) : v instanceof Error ? oneLineError(v) : v);
  const extra = (fields: LogFields | undefined): unknown[] => {
    const merged = Object.fromEntries(Object.entries({ ...rest, ...fields }).map(([k, v]) => [k, safe(v)]));
    const keys = Object.keys(merged);
    if (keys.length === 0) return [];
    if (keys.length === 1 && keys[0] === 'err') return [merged.err];
    return [merged];
  };
  return {
    debug: (message, fields) => console.debug(`${prefix}${oneLine(message)}`, ...extra(fields)),
    info: (message, fields) => console.log(`${prefix}${oneLine(message)}`, ...extra(fields)),
    warn: (message, fields) => console.warn(`${prefix}${oneLine(message)}`, ...extra(fields)),
    error: (message, fields) => console.error(`${prefix}${oneLine(message)}`, ...extra(fields)),
    child: (more) => createConsoleLogger({ ...bindings, ...more }),
  };
}

