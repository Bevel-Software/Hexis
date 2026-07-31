import { useEffect } from 'react';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useEventBus } from './event-bus.context';

/**
 * Bridges the WorkspaceContext's active `workspaceId` to the EventBus's
 * server-side focus filter. Whenever the user switches branch (a pure URL
 * navigation under the per-branch workspace model), the workspace bootstrap
 * updates `workspaceId` and this component POSTs the new id to the events
 * route so the SSE stream starts delivering broadcast events for the new
 * branch's workspace.
 *
 * Renders nothing — it's a pure side-effect bridge. Lives between the
 * EventBus and Workspace providers so it has access to both contexts.
 */
export function EventBusFocusBinder() {
  const workspace = useWorkspace();
  const bus = useEventBus();
  const workspaceId = workspace?.workspaceId ?? null;
  useEffect(() => {
    if (!bus) return;
    bus.setFocus(workspaceId);
  }, [bus, workspaceId]);
  return null;
}
