import { describe, expect, it, vi } from 'vitest';
import { McpSessionStore } from '../mcp-session-store.js';

/**
 * Builds a store with a controllable clock so the idle-TTL and eviction
 * paths don't depend on real time. Tests bump `clock.ts` directly between
 * operations.
 */
function makeStore(opts: { idleTtlMs?: number; maxSessions?: number } = {}) {
  const clock = { ts: 1_000_000 };
  const store = new McpSessionStore({
    idleTtlMs: opts.idleTtlMs ?? 60_000,
    maxSessions: opts.maxSessions ?? 100,
    now: () => clock.ts,
  });
  return { store, clock };
}

describe('McpSessionStore', () => {
  it('create + get round-trips the session', () => {
    const { store } = makeStore();
    store.create('sess-1', 'user-A');

    const session = store.get('sess-1');
    expect(session?.userId).toBe('user-A');
  });

  it('get bumps lastTouchedAt so an active session never ages out under steady use', () => {
    const { store, clock } = makeStore({ idleTtlMs: 1000 });
    store.create('sess-1', 'user-A');

    // Advance just below TTL and touch; advance again just below TTL and
    // touch. Total elapsed > TTL, but no single gap exceeds it.
    clock.ts += 900;
    expect(store.get('sess-1')).not.toBeNull();
    clock.ts += 900;
    expect(store.get('sess-1')).not.toBeNull();
  });

  it('get returns null and drops the session once idle longer than ttl', () => {
    const { store, clock } = makeStore({ idleTtlMs: 1000 });
    store.create('sess-1', 'user-A');

    clock.ts += 1500;
    expect(store.get('sess-1')).toBeNull();
    // The sweep ran during the get, so the entry is actually gone.
    expect(store.size()).toBe(0);
  });

  it('evicts the oldest-touched session when the size cap is hit', () => {
    const { store, clock } = makeStore({ maxSessions: 2 });

    store.create('old', 'user-A');
    clock.ts += 10;
    store.create('middle', 'user-B');
    clock.ts += 10;
    // Touch `middle` so `old` is the oldest-touched.
    store.get('middle');

    clock.ts += 10;
    store.create('new', 'user-C');

    expect(store.get('old')).toBeNull();
    expect(store.get('middle')).not.toBeNull();
    expect(store.get('new')).not.toBeNull();
    expect(store.size()).toBe(2);
  });

  it('delete removes an entry immediately', () => {
    const { store } = makeStore();
    store.create('sess-1', 'user-A');
    store.delete('sess-1');
    expect(store.get('sess-1')).toBeNull();
  });

  describe('onEvict', () => {
    it('fires the listener with the session id when the TTL sweep drops an entry', () => {
      const { store, clock } = makeStore({ idleTtlMs: 1000 });
      const evicted: string[] = [];
      store.onEvict((id) => evicted.push(id));
      store.create('sess-1', 'user-A');

      clock.ts += 1500;
      store.get('sess-1'); // triggers sweep

      expect(evicted).toEqual(['sess-1']);
    });

    it('fires the listener with the session id when the size cap evicts the oldest', () => {
      const { store, clock } = makeStore({ maxSessions: 2 });
      const evicted: string[] = [];
      store.onEvict((id) => evicted.push(id));

      store.create('old', 'user-A');
      clock.ts += 10;
      store.create('middle', 'user-B');
      clock.ts += 10;
      store.get('middle'); // bumps middle, so `old` is oldest-touched

      clock.ts += 10;
      store.create('new', 'user-C');

      expect(evicted).toEqual(['old']);
    });

    it('does NOT fire on explicit delete() — that path is the consumer asking for removal', () => {
      const { store } = makeStore();
      const evicted: string[] = [];
      store.onEvict((id) => evicted.push(id));
      store.create('sess-1', 'user-A');

      store.delete('sess-1');

      expect(evicted).toEqual([]);
    });

    it('keeps sweeping the remaining entries when a listener throws', () => {
      const { store, clock } = makeStore({ idleTtlMs: 1000 });
      const evicted: string[] = [];
      store.onEvict((id) => {
        if (id === 'sess-1') throw new Error('bad listener');
        evicted.push(id);
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      store.create('sess-1', 'user-A');
      store.create('sess-2', 'user-B');
      clock.ts += 1500;
      store.create('trigger', 'user-C'); // sweep runs at create time too

      // Both 'sess-1' (listener threw) and 'sess-2' must have been swept;
      // we observe sess-2 in `evicted` and sess-1 via the warn spy.
      expect(evicted).toContain('sess-2');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('returns an unsubscribe function that stops further notifications', () => {
      const { store, clock } = makeStore({ idleTtlMs: 1000 });
      const evicted: string[] = [];
      const off = store.onEvict((id) => evicted.push(id));

      store.create('sess-1', 'user-A');
      off();
      clock.ts += 1500;
      store.get('sess-1');

      expect(evicted).toEqual([]);
    });
  });
});
