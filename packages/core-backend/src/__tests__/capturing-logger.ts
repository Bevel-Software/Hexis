import type { ILogger, LogFields } from '../shared/logger.contract.js';

/** One line a capturing logger kept: its level, message, and fields with the child bindings folded in. */
export interface CapturedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

/**
 * A logger that keeps every line instead of printing it — the one capturing
 * implementation a suite installs through `setLogger` (restoring the previous
 * one in `finally`) or hands to code that takes an `ILogger`, when what is
 * logged is the behaviour under test. Children fold their bindings into each
 * line's fields, so `module: 'database'` is asserted like any other field.
 */
export function capturingLogger(): { logger: ILogger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const make = (bindings: LogFields): ILogger => {
    const line = (level: CapturedLine['level']) => (message: string, fields: LogFields = {}) =>
      void lines.push({ level, message, fields: { ...bindings, ...fields } });
    return {
      debug: line('debug'),
      info: line('info'),
      warn: line('warn'),
      error: line('error'),
      child: (more) => make({ ...bindings, ...more }),
    };
  };
  return { logger: make({}), lines };
}
