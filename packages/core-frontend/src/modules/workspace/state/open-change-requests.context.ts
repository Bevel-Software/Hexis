import { createContext } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

export interface OpenChangeRequests {
  /** Workspace-relative, kbDirName-prefixed paths with ≥1 open request. */
  paths: ReadonlySet<string>;
  /** The requests touching one workspace-relative path, for the page banner. */
  forPath(path: string): PullRequestSummary[];
}

/**
 * The default is a real, empty answer rather than a throw. The tree and the tab
 * strip are both rendered in unit tests that have no reason to care about
 * change requests, and "no dot" is the correct answer there.
 */
export const NO_CHANGE_REQUESTS: OpenChangeRequests = {
  paths: new Set<string>(),
  forPath: () => [],
};

/** The provider lives in `./open-change-requests.tsx`. */
export const OpenChangeRequestsContext =
  createContext<OpenChangeRequests>(NO_CHANGE_REQUESTS);
