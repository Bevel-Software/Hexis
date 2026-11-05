let last = 0;

/**
 * An instant on the one clock that fetch starts and `fetchedSince` instants
 * are read from. Milliseconds, like `Date.now()`, but strictly increasing in
 * call order: two readings never compare equal, so a fetch started in the
 * same millisecond as a listing is still ordered before or after it, and
 * "started after the instant" is a strict comparison that cannot be a tie.
 */
export function fetchInstant(): number {
  last = Math.max(Date.now(), last + 0.001);
  return last;
}
