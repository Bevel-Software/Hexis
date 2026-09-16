import { useEffect } from 'react';
import { PR_STALE_EVENT } from '../../../core/events';
import { useEventBus } from './event-bus.context';

/**
 * Bus events after which every change-request list on the page is out of
 * date, whoever caused them. `resync` is here because it means the server
 * could not replay what this tab missed — any of the others among it.
 */
const STALE_KINDS = [
  'change-request-merged',
  'change-request-rejected',
  'change-request-apply-failed',
  'resync',
] as const;

/**
 * Bridges change-request lifecycle events on the bus to {@link PR_STALE_EVENT},
 * the one signal every change-request list already refetches on (the tree's
 * open-request provider, the review dock, the Library catalog).
 *
 * Without it, only the tab that CLICKED Apply ever refreshed: the stale event
 * was dispatched by that tab's own apply callback, so the author of the
 * request and every other viewer kept its tree markers and its pending row
 * until a manual reload — the "accepted request still shows as pending" bug.
 * The merge was already broadcast to every session; nothing was listening.
 *
 * Renders nothing. Mounted once per tab, inside the bus provider.
 */
export function ChangeRequestStaleBinder() {
  const bus = useEventBus();
  useEffect(() => {
    if (!bus) return;
    const markStale = () => window.dispatchEvent(new Event(PR_STALE_EVENT));
    const offs = STALE_KINDS.map((kind) => bus.subscribe(kind, markStale));
    return () => {
      for (const off of offs) off();
    };
  }, [bus]);
  return null;
}
