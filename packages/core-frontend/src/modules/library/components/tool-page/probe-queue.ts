/**
 * The connection probe in flight per tool, keyed by slug.
 *
 * Lives OUTSIDE the component on purpose. Saving a credential calls
 * `onChanged`, which reloads the tool page; the reload resets the page to its
 * loading state, `ToolPage` early-returns, and `ToolConnectionSection`
 * unmounts. A `useRef` dies with it — so the second of two quick saves would
 * find an empty queue and start a probe alongside the first, which is the exact
 * race the chaining exists to prevent.
 *
 * Its own module rather than a constant beside the component, because a
 * component file that also exports a plain function breaks fast refresh for the
 * whole module (same reason `status.ts` is separate from `LibraryPage`).
 *
 * Keyed by slug so two tools never wait on each other, and entries are removed
 * as each probe settles, so this holds at most one promise per tool currently
 * being checked.
 */
const probesInFlight = new Map<string, Promise<void>>();

/**
 * Run `check` after whatever probe is already queued for `slug`, so probes for
 * one tool never overlap.
 *
 * The server independently refuses a probe older than the verdict it would
 * overwrite, so a lost race cannot publish a stale result either way. What this
 * adds is that the LAST save is the one whose result the user sees, rather than
 * whichever request happened to finish last.
 */
export async function queueProbe(slug: string, check: () => Promise<void>): Promise<void> {
  const prior = probesInFlight.get(slug);
  const run = (async () => {
    // A failed prior probe must not cancel the one behind it — that one is
    // testing a newer credential and deserves its own answer.
    if (prior) await prior.catch(() => {});
    await check();
  })();
  probesInFlight.set(slug, run);
  try {
    await run;
  } finally {
    if (probesInFlight.get(slug) === run) probesInFlight.delete(slug);
  }
}

/**
 * Drop every queued probe. FOR TESTS ONLY: the map is module-level, so without
 * this one test's in-flight promise becomes the next test's `prior` and the
 * suite silently becomes order-dependent.
 */
export function resetProbeQueueForTests(): void {
  probesInFlight.clear();
}
