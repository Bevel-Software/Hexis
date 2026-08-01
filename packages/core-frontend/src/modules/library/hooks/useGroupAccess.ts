import { useCallback, useEffect, useState } from 'react';
import {
  fetchAccessOverrides,
  fetchFileAccess,
  type AccessOverride,
  type AccessResponse,
} from '../../access/api';
import { DEFAULT_WORKSPACE_ID } from '../services/library.api';

export interface GroupFolderAccess {
  /** The resolved folder verdict + share lists; null until loaded or on error. */
  access: AccessResponse | null;
  /** Rules declared inside the folder. `[]` until loaded, and on any failure. */
  overrides: AccessOverride[];
  /** True when the scan hit its file cap and the list is partial. */
  truncated: boolean;
  /** True only while the SUMMARY fetch is in flight. */
  loading: boolean;
  /** The summary's failure. Overrides failures degrade silently to `[]`. */
  error: string | null;
  reload(): void;
}

/**
 * One group folder's access, as a display of record.
 *
 * Deliberately NOT `useFileAccess`: that hook default-ALLOWS on error, which is
 * right for an editor (the backend is the real gate at save time) and wrong
 * here. This surface's whole job is to state who can do what, so a failed fetch
 * has to read as "we could not find out" — never as a confident, invented
 * answer.
 *
 * The two calls fail differently on purpose. The summary IS the section, so its
 * failure is surfaced. The overrides call is a supplement, and a 403 from it is
 * a normal outcome for someone who reached the folder through a per-item grant
 * — so it degrades to `[]` and says nothing at all.
 *
 * Always pinned to `DEFAULT_WORKSPACE_ID`: group access is a property of the
 * default branch, not of whichever branch the user happens to have open.
 */
export function useGroupFolderAccess(folder: string): GroupFolderAccess {
  const [access, setAccess] = useState<AccessResponse | null>(null);
  const [overrides, setOverrides] = useState<AccessOverride[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchFileAccess(DEFAULT_WORKSPACE_ID, folder, 'folder')
      .then((res) => {
        if (cancelled) return;
        setAccess(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load access for this group.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    fetchAccessOverrides(DEFAULT_WORKSPACE_ID, folder)
      .then((res) => {
        if (cancelled) return;
        setOverrides(res.overrides);
        setTruncated(res.truncated);
      })
      .catch(() => {
        if (cancelled) return;
        setOverrides([]);
        setTruncated(false);
      });

    return () => {
      cancelled = true;
    };
  }, [folder, revision]);

  const reload = useCallback(() => setRevision((r) => r + 1), []);

  return { access, overrides, truncated, loading, error, reload };
}
