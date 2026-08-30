import { useEffect, useRef, useState } from 'react';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { readFileOnBranch } from '../../change-requests/services/change-requests.api';

/**
 * The raw bytes of a tool's definition file, read LAZILY — nothing is asked
 * for until the caller says the source section is open.
 *
 * Why the official version and not the reader's current branch: the tool
 * catalog is resolved against the default branch, so that is the file the
 * platform actually runs AND the file whose read verdict admitted the tool to
 * the page in the first place. Reading any other branch could 404 (or refuse)
 * a file the listing just showed, and would show a draft as if it were live.
 *
 * Access needs no check here. `GET /api/workspace/:id/file` applies the same
 * per-file read rule the tool listing filters on, against the same
 * repo-relative path — so the endpoint is the authority, and a refusal simply
 * lands as the error state.
 *
 * Not `useDefaultBranchFile`, which reads the same file from the same branch:
 * that hook collapses "still reading" and "could not read" into one `null`,
 * because its callers (a diff, an editor seed) render nothing either way. A
 * disclosure must tell them apart — it owes the reader a visible answer when
 * the read fails, and a silent spinner is not one.
 */
export type ToolSourceStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface ToolSourceState {
  status: ToolSourceStatus;
  /** The file's text, verbatim — only on `loaded`. */
  content: string | null;
}

const IDLE: ToolSourceState = { status: 'idle', content: null };
const LOADING: ToolSourceState = { status: 'loading', content: null };
const FAILED: ToolSourceState = { status: 'error', content: null };

export function useToolSource(path: string | null, open: boolean): ToolSourceState {
  const [state, setState] = useState<ToolSourceState>(IDLE);
  const requestRef = useRef(0);

  /**
   * `null` while closed, which is what makes the fetch lazy and what makes a
   * close-then-reopen RETRY: the key changes on both edges, so a failed read is
   * never cached as the section's permanent answer.
   *
   * Reset during render against the previous key, not in the effect — the same
   * rule `useToolPage` follows. An effect would repaint the previous tool's
   * source under the new heading for a frame, and the synchronous setState is
   * what `react-hooks/set-state-in-effect` flags.
   */
  const key = open && path ? path : null;
  const [seenKey, setSeenKey] = useState(key);
  if (key !== seenKey) {
    setSeenKey(key);
    setState(key === null ? IDLE : LOADING);
  }

  useEffect(() => {
    // Bumped on every pass, closes included, so an answer for a path the
    // reader has already navigated (or closed) away from can never land.
    const request = ++requestRef.current;
    if (key === null) return;

    readFileOnBranch(DEFAULT_BRANCH, key)
      .then((content) => {
        if (requestRef.current === request) setState({ status: 'loaded', content });
      })
      .catch(() => {
        // Deliberately not the backend's message: a read refusal and a missing
        // file must read the same, the way the page's not-found state does.
        if (requestRef.current === request) setState(FAILED);
      });
  }, [key]);

  return state;
}
