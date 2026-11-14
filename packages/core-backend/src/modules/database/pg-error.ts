/**
 * The Postgres SQLSTATE of a failed query, or undefined when the error is not
 * one Postgres raised. node-postgres puts `code` on the driver error; Drizzle
 * (0.44 and later) wraps that error in a `DrizzleQueryError` whose `cause`
 * carries it. So the code is read off the error and, failing that, off its
 * cause — one level, which is all either wrapping adds.
 */
export function pgErrorCode(err: unknown): string | undefined {
  const codeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);
  const own = codeOf(err);
  if (typeof own === 'string') return own;
  const cause = typeof err === 'object' && err !== null ? (err as { cause?: unknown }).cause : undefined;
  const wrapped = codeOf(cause);
  return typeof wrapped === 'string' ? wrapped : undefined;
}
