import { useEffect } from 'react';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { useEventBus, type EventHandler } from '../state/event-bus.context';

/**
 * Subscribe to a single event kind for the lifetime of the calling
 * component. The handler is re-bound when `kind` or `handler` identity
 * changes — wrap your handler in `useCallback` (or move it outside the
 * component) if you want a stable subscription.
 *
 * No-op when used outside the EventBusProvider (e.g. in unit tests that
 * don't mount it). That lets components subscribe unconditionally
 * without each test having to scaffold the bus.
 */
export function useEventBusSubscription<K extends WorkflowEvent['kind']>(
  kind: K,
  handler: EventHandler<K>,
): void {
  const bus = useEventBus();
  useEffect(() => {
    if (!bus) return;
    return bus.subscribe(kind, handler);
  }, [bus, kind, handler]);
}
