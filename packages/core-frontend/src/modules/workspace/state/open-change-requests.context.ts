import { createContext } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

export interface OpenChangeRequests {
  /** Workspace-relative, kbDirName-prefixed paths with ≥1 open request. */
  paths: ReadonlySet<string>;
  /** The requests touching one workspace-relative path, for the page banner. */
  forPath(path: string): PullRequestSummary[];
  /**
   * The CALLER'S OWN open requests' touched files: workspace-relative path →
   * change-request number. This is what lets the tree show a file you have
   * proposed but that does not exist on this branch yet — the row is
   * synthesized from this map, and clicking it opens the change request
   * (there is no content on this branch to show).
   */
  minePaths: ReadonlyMap<string, number>;
  /** The caller's own open request NUMBERS — "is this one mine?" for the boxes. */
  mineNumbers: ReadonlySet<number>;
}

/**
 * The default is a real, empty answer rather than a throw. The tree and the tab
 * strip are both rendered in unit tests that have no reason to care about
 * change requests, and "no dot" is the correct answer there.
 */
export const NO_CHANGE_REQUESTS: OpenChangeRequests = {
  paths: new Set<string>(),
  forPath: () => [],
  minePaths: new Map<string, number>(),
  mineNumbers: new Set<number>(),
};

/** The provider lives in `./open-change-requests.tsx`. */
export const OpenChangeRequestsContext =
  createContext<OpenChangeRequests>(NO_CHANGE_REQUESTS);
