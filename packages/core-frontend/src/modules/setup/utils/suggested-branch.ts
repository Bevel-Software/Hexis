import type { ConnectionTest } from '../services/setup.api';

/**
 * Which branch the repository just named, or the best conventional stand-in.
 *
 * Prefer what the remote calls its trunk. Not every host advertises it —
 * older servers answer `ls-remote` without the symref line — so fall back to
 * the conventional names before the first branch it did list. Leaving these
 * blank is the one way a save can succeed and still not finish setup, which
 * is worth a guess the reader can see and correct.
 *
 * An EMPTY repository has no branch to report, but it will be seeded with
 * whatever is configured, so the conventional name is the right suggestion.
 * Suggesting nothing was the one way "Connected" could still end, silently,
 * in a save that did not finish setup.
 *
 * ONE function for every screen that tests a connection, because two copies
 * of "which branch did it name?" is how two answers drift apart.
 */
export function suggestedBranch(result: ConnectionTest): string | null {
  return (
    result.defaultBranch ||
    ['main', 'master', 'trunk'].find((name) => result.branches?.includes(name)) ||
    result.branches?.[0] ||
    (result.empty ? 'main' : null)
  );
}
