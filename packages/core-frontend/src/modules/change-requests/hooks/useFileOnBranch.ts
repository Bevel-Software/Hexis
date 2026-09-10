import { useEffect, useRef, useState } from 'react';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { readFileOnBranch } from '../services/change-requests.api';

/**
 * A read that has landed, or the fact that it hasn't.
 *
 * `content: null` on its own conflates two different truths — "still in
 * flight" and "this read is never going to succeed" — and a caller holding
 * only that can render exactly one thing for both: "Loading…", forever. A
 * file the default branch simply does not have (the OLD half of a rename, a
 * path outside the caller's access) is the second case, and it deserves a
 * sentence rather than a spinner.
 */
export interface BranchFileRead {
  /** The file's raw text once it lands; `null` while pending AND on failure. */
  content: string | null;
  /** True once the read SETTLED as an error — a definitive "no", not a wait. */
  failed: boolean;
}

const PENDING: BranchFileRead = { content: null, failed: false };
const FAILED: BranchFileRead = { content: null, failed: true };

/**
 * The file's RAW text on the default branch.
 *
 * Not `skill.body`, which is what the skills API returns for SKILL.md: that has
 * already had the frontmatter parsed off. Two things here need the bytes as
 * they sit in git, and both break quietly on the parsed body —
 *
 *  - the DIFF, whose other side is a raw branch read. Body-vs-raw makes the
 *    frontmatter look like a deletion and marks the entire file as changed.
 *  - the EDITOR, whose text is written back as the whole file. Seeding it from
 *    the body would commit a SKILL.md with its `name`/`description`/
 *    `allowed-tools` frontmatter deleted.
 *
 * Keyed by path + revision, so a tab switch cannot show the previous file.
 */
export function useDefaultBranchFile(
  repoRelativePath: string | null,
  revision = 0,
): string | null {
  return useFileOnBranch(DEFAULT_BRANCH, repoRelativePath, revision);
}

/** The same default-branch read, with a failure distinguishable from a wait. */
export function useDefaultBranchFileRead(
  repoRelativePath: string | null,
  revision = 0,
): BranchFileRead {
  return useFileOnBranchRead(DEFAULT_BRANCH, repoRelativePath, revision);
}

/**
 * The same read against ANY branch — `null` branch means "don't fetch". The
 * skill page uses it to seed an incremental proposal: when the caller already
 * has an open change request, the editor's base is the file as it reads on
 * THEIR suggestions branch, so a second round of edits stacks on the first
 * instead of silently starting over from the default branch.
 */
export function useFileOnBranch(
  branch: string | null,
  repoRelativePath: string | null,
  revision = 0,
): string | null {
  return useFileOnBranchRead(branch, repoRelativePath, revision).content;
}

/**
 * The read itself. Callers that can say something useful about a failure take
 * this; callers that only ever want the text take the `string | null` wrappers
 * above.
 */
export function useFileOnBranchRead(
  branch: string | null,
  repoRelativePath: string | null,
  revision = 0,
): BranchFileRead {
  /**
   * Answers are cached PER KEY, not as "the last one". The skill page's tabs
   * make the path oscillate (SKILL.md → a bundled file → SKILL.md), and with a
   * single-slot state the return leg found its key already in `asked` — so no
   * refetch — while the slot held the other tab's answer: the hook returned
   * null forever and the pane sat on "Loading…". A map keeps every settled
   * answer addressable for as long as the page is mounted (bounded: one entry
   * per file per revision).
   *
   * A FAILURE is cached under its key too, for the same reason the successes
   * are: it is an answer. Storing nothing left the key indistinguishable from
   * one still in flight.
   */
  const cache = useRef<Map<string, BranchFileRead>>(new Map());
  const asked = useRef<Set<string>>(new Set());
  const [, arrived] = useState(0);
  const key = `${branch ?? ''}::${repoRelativePath ?? ''}::${revision}`;

  /**
   * No `cancelled` flag, deliberately — pairing one with the `asked` guard
   * DEADLOCKS under StrictMode's double-invoked effects: the first run starts
   * the fetch and marks the key asked, its cleanup sets `cancelled`, and the
   * second run sees the key already asked and never refetches. The result
   * arrives and is thrown away, so the caller waits forever. (That is exactly
   * how this shipped: the change-request view sat on "Loading…" while both
   * reads returned 200.)
   *
   * A late answer needs no discarding at all anymore: it lands in the cache
   * under its own key, and the read below simply doesn't look there.
   */
  useEffect(() => {
    if (!branch || !repoRelativePath || asked.current.has(key)) return;
    asked.current.add(key);
    readFileOnBranch(branch, repoRelativePath)
      .then((content) => {
        cache.current.set(key, { content, failed: false });
        arrived((n) => n + 1);
      })
      .catch(() => {
        // NOT `{ content: '' }`: an empty string would diff as "the whole file
        // was deleted". The failure is recorded as a failure so the caller can
        // say so.
        cache.current.set(key, FAILED);
        arrived((n) => n + 1);
      });
  }, [branch, repoRelativePath, key]);

  // No path (or no branch) is not a failure — it is "nothing was asked for".
  if (!branch || !repoRelativePath) return PENDING;
  return cache.current.get(key) ?? PENDING;
}
