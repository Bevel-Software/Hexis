import { useMemo } from 'react';
import {
  useAccessRequests,
  type AccessRequestsState,
} from '../../access/hooks/useAccessRequests';
import {
  listJoinRequests,
  reconcileJoinRequest,
  type JoinProposal,
  type JoinRequest,
} from '../services/plugins.api';
import { useLibraryToast } from '../state/toast.context';

/**
 * The Library's face of {@link useAccessRequests}: one plugin's (or skill's)
 * join requests, with the failures said as Library toasts.
 *
 * Everything about how a request is answered lives in the access module now —
 * accepting is a grant, declining rejects the change request, and the request
 * retires itself. What stays here is where the words go: the Library has a
 * toast host, and the Manage access dialog does not, which is why the generic
 * hook reports failures as state and lets each surface choose.
 */
export interface JoinRequestsState {
  requests: JoinRequest[];
  accept(request: JoinRequest, proposal: JoinProposal): Promise<void>;
  decline(request: JoinRequest): Promise<void>;
  reload(): void;
}

/**
 * Where the requests come from. The default is a plugin's join requests; a
 * skill page passes the skill's write-access endpoints instead — same
 * proposals, same accept-by-grant, a different folder.
 */
export interface JoinRequestsApi {
  list(name: string): Promise<JoinRequest[]>;
  reconcile(name: string, number: number): Promise<boolean>;
}

// Lazy wrappers, not the functions themselves: the plugin API is resolved at
// call time, so a surface that never lists requests never needs those exports.
const PLUGIN_JOIN_API: JoinRequestsApi = {
  list: (name) => listJoinRequests(name),
  reconcile: (name, number) => reconcileJoinRequest(name, number),
};

export function useJoinRequests(
  plugin: string,
  folder: string | null,
  api: JoinRequestsApi = PLUGIN_JOIN_API,
): JoinRequestsState {
  const toast = useLibraryToast();
  const source = useMemo(
    () => ({
      list: () => api.list(plugin),
      reconcile: (number: number) => api.reconcile(plugin, number),
    }),
    [api, plugin],
  );
  const state: AccessRequestsState = useAccessRequests({
    itemKey: plugin,
    source,
    grantOn: folder ? { path: folder, kind: 'folder' } : null,
    onError: (message) => toast(message, 'danger'),
    onAccepted: (message) => toast(message),
  });
  return state;
}
