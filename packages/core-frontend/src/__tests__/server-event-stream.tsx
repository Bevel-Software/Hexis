import { onTestFinished } from 'vitest';
import type { WorkflowEvent } from '@bevel-software/platform-shared';

export interface ServerEventStream {
  emit(event: WorkflowEvent): void;
}

let installed: ServerEventStream | null = null;

/**
 * The server's event stream, for a test that mounts the app's own
 * `EventBusProvider` (the workflow module's public entry) and needs to play
 * server events into it.
 *
 * jsdom ships no EventSource, so this stands in for the stream the provider
 * opens on mount; `emit` hands every open stream one event the way the
 * server would (wrap it in `act`, as any state change). The provider also
 * POSTs its focus to `/api/events/…`: those requests are answered 200 here,
 * and every other request goes to the fetch that was in place before. Call it
 * inside the test, before the render; the stubs come off when the test ends. A
 * second call in the same test answers the stream the first one installed, so
 * a render helper can install it and a test can still reach it.
 */
export function stubServerEventStream(): ServerEventStream {
  if (installed) return installed;
  const open = new Set<FakeEventSource>();

  class FakeEventSource {
    private readonly listeners = new Map<string, ((e: Event) => void)[]>();
    constructor() {
      open.add(this);
    }
    addEventListener(type: string, fn: (e: Event) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    removeEventListener(type: string, fn: (e: Event) => void) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
    }
    close() {
      open.delete(this);
    }
    deliver(event: WorkflowEvent) {
      for (const fn of [...(this.listeners.get('message') ?? [])]) {
        fn(new MessageEvent('message', { data: JSON.stringify(event) }));
      }
    }
  }

  const g = globalThis as { EventSource?: unknown; fetch: typeof fetch };
  const beforeSource = g.EventSource;
  const before = g.fetch;
  const fetchOrFocus: typeof fetch = (input, init) =>
    String(input instanceof Request ? input.url : input).startsWith('/api/events/')
      ? Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      : before(input, init);
  g.EventSource = FakeEventSource;
  g.fetch = fetchOrFocus;
  // Only this helper's own stubs come off: a fetch spy the test put in place
  // meanwhile is the test's to restore, in whichever order the two run.
  onTestFinished(() => {
    installed = null;
    if (g.EventSource === FakeEventSource) g.EventSource = beforeSource;
    if (g.fetch === fetchOrFocus) g.fetch = before;
  });

  installed = {
    emit(event) {
      for (const source of [...open]) source.deliver(event);
    },
  };
  return installed;
}
