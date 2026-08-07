import { describe, it, expect, vi } from 'vitest';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { WorkflowEventBus } from '../event-bus.js';

/**
 * Make a `Subscriber`-compatible spy. Returns the spy + a getter for
 * the focused workspace id (mutable via the returned `setFocus`) so
 * tests can simulate focus changes without re-subscribing.
 */
function makeSubscriber(sessionId: string, userId: string, initialFocus: string | null = null) {
  let focus = initialFocus;
  const push = vi.fn();
  return {
    sessionId,
    userId,
    push,
    getFocusedWorkspaceId: () => focus,
    setFocus: (id: string | null) => { focus = id; },
  };
}

describe('WorkflowEventBus', () => {
  describe('scope filtering', () => {
    it('delivers workspace-scoped events only to sessions focused on that workspace', () => {
      const bus = new WorkflowEventBus();
      const onA = makeSubscriber('s-a', 'u-1', 'ws-feat');
      const onB = makeSubscriber('s-b', 'u-2', 'ws-other');
      bus.subscribe(onA);
      bus.subscribe(onB);

      bus.emit({
        kind: 'file-changed',
        workspaceId: 'ws-feat',
        branch: 'feat',
        path: 'Foo.md',
        newSha: 'abc',
        byUserId: 'u-1',
        byUserName: 'Alice',
      });

      expect(onA.push).toHaveBeenCalledTimes(1);
      expect(onB.push).not.toHaveBeenCalled();
    });

    it('matches workspace focus across URL-encoded vs decoded forms', () => {
      // The frontend stores `workspace.id` as `encodeURIComponent(branch)` and
      // sends that as the SSE focus value. The route handlers, however,
      // extract `req.params.id` which Express auto-decodes. Without
      // canonicalisation, workspace-scoped events for any branch with a `/`
      // never reach the receiver — the silent bug we hit on
      // `razvan-radulescu/sc`.
      const bus = new WorkflowEventBus();
      const encodedFocus = makeSubscriber('s-enc', 'u-1', 'razvan-radulescu%2Fsc');
      const decodedFocus = makeSubscriber('s-dec', 'u-2', 'razvan-radulescu/sc');
      bus.subscribe(encodedFocus);
      bus.subscribe(decodedFocus);

      // Event fired with the DECODED form (mirrors what Express's
      // req.params.id passes into workflow methods).
      bus.emit({
        kind: 'lock-released',
        workspaceId: 'razvan-radulescu/sc',
        branch: 'razvan-radulescu/sc',
        path: 'Knowledge/Foo.md',
      });
      expect(encodedFocus.push).toHaveBeenCalledTimes(1);
      expect(decodedFocus.push).toHaveBeenCalledTimes(1);

      // …and the symmetric case: event with the ENCODED form still
      // reaches both forms of focus.
      bus.emit({
        kind: 'lock-released',
        workspaceId: 'razvan-radulescu%2Fsc',
        branch: 'razvan-radulescu/sc',
        path: 'Knowledge/Foo.md',
      });
      expect(encodedFocus.push).toHaveBeenCalledTimes(2);
      expect(decodedFocus.push).toHaveBeenCalledTimes(2);
    });

    it('delivers user-scoped events only to sessions belonging to that user', () => {
      const bus = new WorkflowEventBus();
      const onAlice = makeSubscriber('s-alice', 'u-alice');
      const onBob = makeSubscriber('s-bob', 'u-bob');
      bus.subscribe(onAlice);
      bus.subscribe(onBob);

      bus.emit({
        kind: 'agent-tool-call',
        forUserId: 'u-alice',
        threadId: 't-1',
        tool: 'write_file',
        summary: 'writing Knowledge/Foo.md',
      });

      expect(onAlice.push).toHaveBeenCalledTimes(1);
      expect(onBob.push).not.toHaveBeenCalled();
    });

    it('delivers change-request-merge-failed only to the user who triggered the merge', () => {
      const bus = new WorkflowEventBus();
      const onAlice = makeSubscriber('s-alice', 'u-alice');
      const onBob = makeSubscriber('s-bob', 'u-bob');
      bus.subscribe(onAlice);
      bus.subscribe(onBob);

      bus.emit({
        kind: 'change-request-merge-failed',
        forUserId: 'u-alice',
        number: 91,
        reason: 'gh pr merge failed',
        conflicts: false,
      });

      expect(onAlice.push).toHaveBeenCalledTimes(1);
      expect(onBob.push).not.toHaveBeenCalled();
    });

    it("delivers global events (e.g. change-request-opened) to every subscriber regardless of focus or user", () => {
      const bus = new WorkflowEventBus();
      const onA = makeSubscriber('s-a', 'u-1', null); // no focus at all
      const onB = makeSubscriber('s-b', 'u-2', 'ws-other');
      bus.subscribe(onA);
      bus.subscribe(onB);

      bus.emit({
        kind: 'change-request-opened',
        number: 42,
        source: 'feat',
        target: 'target-company-state',
        authorIdHash: 'h',
        title: 'Add Foo',
      });

      expect(onA.push).toHaveBeenCalledTimes(1);
      expect(onB.push).toHaveBeenCalledTimes(1);
    });

    it("skips workspace events for sessions that haven't set a focus yet", () => {
      const bus = new WorkflowEventBus();
      const unfocused = makeSubscriber('s-x', 'u-1', null);
      bus.subscribe(unfocused);

      bus.emit({
        kind: 'lock-acquired',
        workspaceId: 'ws-feat',
        branch: 'feat',
        path: 'Foo.md',
        holderUserId: 'u-2',
        holderName: 'Bob',
      });

      expect(unfocused.push).not.toHaveBeenCalled();
    });

    it('honours a mid-stream focus change without re-subscribing', () => {
      const bus = new WorkflowEventBus();
      const sub = makeSubscriber('s-1', 'u-1', 'ws-a');
      bus.subscribe(sub);

      bus.emit({ kind: 'lock-released', workspaceId: 'ws-a', branch: 'a', path: 'x.md' });
      expect(sub.push).toHaveBeenCalledTimes(1);

      sub.setFocus('ws-b');
      bus.emit({ kind: 'lock-released', workspaceId: 'ws-a', branch: 'a', path: 'x.md' });
      // After re-focusing on ws-b, ws-a events stop reaching this session.
      expect(sub.push).toHaveBeenCalledTimes(1);

      bus.emit({ kind: 'lock-released', workspaceId: 'ws-b', branch: 'b', path: 'y.md' });
      expect(sub.push).toHaveBeenCalledTimes(2);
    });
  });

  describe('envelope', () => {
    it('stamps each event with a monotonic id and an ISO timestamp', () => {
      const bus = new WorkflowEventBus();
      const e1 = bus.emit({ kind: 'change-request-merged', number: 1 });
      const e2 = bus.emit({ kind: 'change-request-merged', number: 2 });
      expect(e1.id).toBe(1);
      expect(e2.id).toBe(2);
      // ISO timestamp shape — parseable by Date.
      expect(Number.isFinite(Date.parse(e1.ts))).toBe(true);
    });
  });

  describe('replay', () => {
    it('returns events strictly after the last-seen id', () => {
      const bus = new WorkflowEventBus();
      const sub = { userId: 'u-1', getFocusedWorkspaceId: () => 'ws-a' };
      bus.emit({ kind: 'lock-released', workspaceId: 'ws-a', branch: 'a', path: '1.md' });
      bus.emit({ kind: 'lock-released', workspaceId: 'ws-a', branch: 'a', path: '2.md' });
      bus.emit({ kind: 'lock-released', workspaceId: 'ws-a', branch: 'a', path: '3.md' });

      const tail = bus.replayAfter(1, sub);
      expect(tail).not.toBeNull();
      expect(tail!.map((e) => (e as WorkflowEvent & { path?: string }).path)).toEqual(['2.md', '3.md']);
    });

    it('respects scope filtering on replay (no leak of other workspaces)', () => {
      const bus = new WorkflowEventBus();
      const sub = { userId: 'u-1', getFocusedWorkspaceId: () => 'ws-a' };
      bus.emit({ kind: 'lock-released', workspaceId: 'ws-a', branch: 'a', path: 'a.md' });
      bus.emit({ kind: 'lock-released', workspaceId: 'ws-b', branch: 'b', path: 'b.md' });
      bus.emit({ kind: 'change-request-merged', number: 5 });

      const tail = bus.replayAfter(0, sub);
      expect(tail).not.toBeNull();
      const kinds = tail!.map((e) => e.kind);
      // ws-a lock-released + global CR merged; ws-b filtered out.
      expect(kinds).toEqual(['lock-released', 'change-request-merged']);
    });

    it('returns null when the requested last-seen id was evicted past the buffer (caller emits resync)', () => {
      // Build a tiny bus and overflow it so the oldest id gets evicted.
      // The bus's BUFFER_CAPACITY is 500 — emit one more than that to
      // force eviction of id 1, then ask to replay after id 0 (which
      // sits BEFORE the now-evicted id 1).
      const bus = new WorkflowEventBus();
      for (let i = 0; i < 501; i++) {
        bus.emit({ kind: 'change-request-merged', number: i + 1 });
      }
      const sub = { userId: 'u-1', getFocusedWorkspaceId: () => null };
      // After 501 emits with capacity 500: ids 2..501 remain, id 1 evicted.
      // Requesting events after id 0 means "everything from id 1 onward",
      // but id 1 is gone — bus must signal a resync rather than silently
      // skip events the caller can't reconstruct.
      expect(bus.replayAfter(0, sub)).toBeNull();
      // Requesting from id 1 is fine — caller has seen 1, just needs 2..501.
      expect(bus.replayAfter(1, sub)).not.toBeNull();
    });

    it('post-restart: empty buffer + non-zero lastSeenId → null (forces resync)', () => {
      // Process restart resets the id counter to 1 and empties the buffer.
      // A client reconnecting with `Last-Event-ID: 42` from before the
      // restart has nothing to find — the events it saw will never come
      // back, and the new id space might happen to reach 42 again with
      // entirely different events. Returning `[]` would silently lie.
      // The bus must return `null` so the route emits a `resync` and the
      // client refetches state from scratch.
      const bus = new WorkflowEventBus();
      const sub = { userId: 'u-1', getFocusedWorkspaceId: () => null };
      expect(bus.replayAfter(42, sub)).toBeNull();
      // First-time client (Last-Event-ID === 0) on an empty buffer is
      // genuinely caught up — replay is an empty array, not a resync.
      expect(bus.replayAfter(0, sub)).toEqual([]);
    });

    it('post-restart: lastSeenId greater than newest buffered id → null (forces resync)', () => {
      // After a restart, the counter starts at 1 again. If the buffer
      // has, say, ids 1..5 (5 emits since restart) and a client
      // reconnects with `Last-Event-ID: 100` from the previous process,
      // the linear `id > lastSeenId` filter would return empty — but the
      // client has actually missed everything in the new id space too.
      // Force a resync so they refetch.
      const bus = new WorkflowEventBus();
      for (let i = 0; i < 5; i++) {
        bus.emit({ kind: 'change-request-merged', number: i + 1 });
      }
      const sub = { userId: 'u-1', getFocusedWorkspaceId: () => null };
      // Newest id is 5; 100 is far ahead → resync.
      expect(bus.replayAfter(100, sub)).toBeNull();
      // 4 is in-buffer → caller gets event 5 back.
      const tail = bus.replayAfter(4, sub);
      expect(tail).not.toBeNull();
      expect(tail!.length).toBe(1);
    });
  });

  describe('subscriber lifecycle', () => {
    it('unsubscribe removes the subscriber from future fan-out', () => {
      const bus = new WorkflowEventBus();
      const sub = makeSubscriber('s-1', 'u-1', 'ws-a');
      const off = bus.subscribe(sub);
      bus.emit({ kind: 'lock-released', workspaceId: 'ws-a', branch: 'a', path: 'x.md' });
      expect(sub.push).toHaveBeenCalledTimes(1);
      off();
      bus.emit({ kind: 'lock-released', workspaceId: 'ws-a', branch: 'a', path: 'y.md' });
      expect(sub.push).toHaveBeenCalledTimes(1);
    });

    it('does not double-emit when a subscriber re-registers with the same sessionId', () => {
      const bus = new WorkflowEventBus();
      const first = makeSubscriber('s-1', 'u-1', 'ws-a');
      const second = makeSubscriber('s-1', 'u-1', 'ws-a'); // same id
      bus.subscribe(first);
      bus.subscribe(second);
      bus.emit({ kind: 'lock-released', workspaceId: 'ws-a', branch: 'a', path: 'x.md' });
      // Only the latest subscriber for that sessionId gets the event —
      // re-subscribing is a replace, not an additive register. Without
      // this guarantee a browser refresh that re-opens the SSE stream
      // with the same sessionId would double-fire every event.
      expect(first.push).not.toHaveBeenCalled();
      expect(second.push).toHaveBeenCalledTimes(1);
    });

    it('absorbs handler exceptions so one bad subscriber does not break the fan-out', () => {
      const bus = new WorkflowEventBus();
      const exploder = makeSubscriber('s-bad', 'u-1', 'ws-a');
      exploder.push.mockImplementation(() => { throw new Error('boom'); });
      const healthy = makeSubscriber('s-good', 'u-2', 'ws-a');
      bus.subscribe(exploder);
      bus.subscribe(healthy);

      expect(() =>
        bus.emit({ kind: 'lock-released', workspaceId: 'ws-a', branch: 'a', path: 'x.md' })
      ).not.toThrow();
      expect(healthy.push).toHaveBeenCalledTimes(1);
    });

    it('size() reflects active subscribers', () => {
      const bus = new WorkflowEventBus();
      expect(bus.size()).toBe(0);
      const off1 = bus.subscribe(makeSubscriber('s-1', 'u-1'));
      const off2 = bus.subscribe(makeSubscriber('s-2', 'u-2'));
      expect(bus.size()).toBe(2);
      off1();
      expect(bus.size()).toBe(1);
      off2();
      expect(bus.size()).toBe(0);
    });
  });

  describe('onEmit — the server-side tap', () => {
    it('sees every event, unfiltered by SSE scope, and unsubscribes cleanly', () => {
      const bus = new WorkflowEventBus();
      const seen: string[] = [];
      const off = bus.onEmit((e) => seen.push(e.kind));
      // A workspace-scoped event with NO matching SSE session still reaches
      // the tap — scope filtering exists for sessions, not in-process
      // consumers (write-time cache invalidation must never miss one).
      bus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws-1', branch: 'main' });
      expect(seen).toEqual(['fs-tree-changed']);
      off();
      bus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws-1', branch: 'main' });
      expect(seen).toEqual(['fs-tree-changed']);
    });

    it('a throwing listener is contained — emit never propagates it', () => {
      const bus = new WorkflowEventBus();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      bus.onEmit(() => {
        throw new Error('bad listener');
      });
      const after: string[] = [];
      bus.onEmit((e) => after.push(e.kind));
      expect(() =>
        bus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws-1', branch: 'main' }),
      ).not.toThrow();
      // …and the listeners after the bad one still ran.
      expect(after).toEqual(['fs-tree-changed']);
      warn.mockRestore();
    });
  });
});
