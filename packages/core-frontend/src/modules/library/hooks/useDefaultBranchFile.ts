import { useEffect, useRef, useState } from 'react';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { readFileOnBranch } from '../services/library.api';

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
  const [file, setFile] = useState<{ key: string; content: string } | null>(null);
  const asked = useRef<Set<string>>(new Set());
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
   * Discarding a stale response is the KEY's job instead: a late answer for a
   * path we have since navigated away from simply stops matching on read.
   */
  useEffect(() => {
    if (!branch || !repoRelativePath || asked.current.has(key)) return;
    asked.current.add(key);
    readFileOnBranch(branch, repoRelativePath)
      .then((content) => setFile({ key, content }))
      .catch(() => {
        // Leave it unset rather than storing '': an empty string would diff as
        // "the whole file was deleted".
      });
  }, [branch, repoRelativePath, key]);

  return file?.key === key ? file.content : null;
}
