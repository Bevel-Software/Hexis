/**
 * Whether a filesystem error means "there is no such path" — the one failure
 * a reader may treat as an ordinary answer. Everything else (permissions,
 * I/O, a loop) is a failure to READ what is there, and a caller that folds
 * it into absence turns an outage into a wrong answer.
 */
export function isAbsence(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
