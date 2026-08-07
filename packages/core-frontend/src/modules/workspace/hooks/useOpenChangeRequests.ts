import { useContext } from 'react';
import {
  OpenChangeRequestsContext,
  type OpenChangeRequests,
} from '../state/open-change-requests.context';

/**
 * Which files have an open change request against them.
 *
 * Reads the one shared fetch — see `OpenChangeRequestsProvider` for the two
 * traps behind it (a different endpoint from the dock, and a path-space
 * conversion that silently matches nothing if skipped).
 *
 * Outside the provider it yields an empty set rather than throwing: the tree
 * and the tab strip are both rendered in unit tests that have no reason to
 * care about change requests, and no dot is the correct answer there.
 */
export function useOpenChangeRequests(): OpenChangeRequests {
  return useContext(OpenChangeRequestsContext);
}
