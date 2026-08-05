import { useCallback, useEffect, useRef, useState } from 'react';
import { getSkill, getSkillFile, type LibrarySkill } from '../services/library.api';

/**
 * Detail-level data for one skill: the SKILL.md body + bundled file list on
 * open, then bundled file contents on demand (cached per file for the dialog's
 * lifetime). Mirrors the backend's progressive disclosure (`getSkill` →
 * `getSkill(file)`).
 */
export interface SkillDetailState {
  skill: LibrarySkill | null;
  loading: boolean;
  error: string | null;
  /** Content of a bundled file (relative to the skill folder), or null while loading. */
  fileContent(relFile: string): string | null;
  /** Kick off (or re-use) the fetch for a bundled file. */
  loadFile(relFile: string): void;
  /**
   * Re-read the skill from the server, discarding the cached file contents.
   *
   * Needed because the body this hook holds is the ONLY copy the reading pane
   * renders, and a merge changes it underneath us: without this, approving a
   * change request left the pane showing the pre-merge text under a message
   * saying the skill now reads with that change.
   */
  reload(): void;
}

export function useSkillDetail(name: string): SkillDetailState {
  const [skill, setSkill] = useState<LibrarySkill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const inFlight = useRef<Set<string>>(new Set());
  /** Bumped by `reload()`; re-runs the fetch below without changing skills. */
  const [revision, setRevision] = useState(0);
  /**
   * Which skill the state on screen belongs to. The distinction cannot come
   * from `revision` — after one reload it is non-zero for the NEXT skill too —
   * so the effect asks this instead of inferring from the counter.
   */
  const shownName = useRef<string | null>(null);
  /**
   * Which load the `contents` map belongs to. A bundled-file read started
   * before a reload resolves after it, and without this its (pre-merge) text
   * lands in the map the reload just cleared — where the `contents[relFile]`
   * guard below then treats it as fetched and never asks again. The stale tab
   * would stay stale for as long as the page is open.
   */
  const epoch = useRef(0);

  const reload = useCallback(() => setRevision((r) => r + 1), []);

  useEffect(() => {
    let cancelled = false;
    // Switching SKILLS blanks first: the old body belongs to a different page
    // and must not be shown for even one frame under the new name. A RELOAD of
    // the same skill does the opposite — it keeps the current text on screen
    // while the new copy is in flight, since stale by one request beats
    // flashing the whole page through its loading state on every merge.
    const switching = shownName.current !== name;
    shownName.current = name;
    if (switching) {
      setSkill(null);
      setLoading(true);
    }
    setContents({});
    inFlight.current = new Set();
    epoch.current += 1;
    setError(null);
    getSkill(name)
      .then((s) => {
        if (cancelled) return;
        setSkill(s);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load this skill.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name, revision]);

  const loadFile = useCallback(
    (relFile: string) => {
      if (contents[relFile] !== undefined || inFlight.current.has(relFile)) return;
      inFlight.current.add(relFile);
      // Which load this read belongs to. A reload moves the epoch on, and an
      // answer from the previous one is about a file as it read BEFORE the
      // merge — dropping it lets the re-issued read fill the gap instead.
      const mine = epoch.current;
      getSkillFile(name, relFile)
        .then((content) => {
          if (epoch.current !== mine) return;
          setContents((c) => ({ ...c, [relFile]: content }));
        })
        .catch(() => {
          if (epoch.current !== mine) return;
          setContents((c) => ({ ...c, [relFile]: "Couldn't load this file." }));
        })
        .finally(() => {
          // Only if the set is still this load's — the effect swaps in a fresh
          // one, and deleting from that would clear a live read's guard.
          if (epoch.current === mine) inFlight.current.delete(relFile);
        });
    },
    [name, contents],
  );

  const fileContent = useCallback(
    (relFile: string) => contents[relFile] ?? null,
    [contents],
  );

  return { skill, loading, error, fileContent, loadFile, reload };
}
