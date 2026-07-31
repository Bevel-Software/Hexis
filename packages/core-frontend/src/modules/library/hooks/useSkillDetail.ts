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
}

export function useSkillDetail(name: string): SkillDetailState {
  const [skill, setSkill] = useState<LibrarySkill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setSkill(null);
    setContents({});
    inFlight.current = new Set();
    setLoading(true);
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
  }, [name]);

  const loadFile = useCallback(
    (relFile: string) => {
      if (contents[relFile] !== undefined || inFlight.current.has(relFile)) return;
      inFlight.current.add(relFile);
      getSkillFile(name, relFile)
        .then((content) => {
          setContents((c) => ({ ...c, [relFile]: content }));
        })
        .catch(() => {
          setContents((c) => ({ ...c, [relFile]: "Couldn't load this file." }));
        })
        .finally(() => {
          inFlight.current.delete(relFile);
        });
    },
    [name, contents],
  );

  const fileContent = useCallback(
    (relFile: string) => contents[relFile] ?? null,
    [contents],
  );

  return { skill, loading, error, fileContent, loadFile };
}
