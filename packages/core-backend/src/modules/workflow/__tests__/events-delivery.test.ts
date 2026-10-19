import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowEvent, WorkflowEventPayload } from '@bevel-software/platform-shared';
import { WorkflowEventBus } from '../event-bus.js';
import { createEventsRoutes } from '../events.routes.js';
import {
  EventDelivery,
  createEventAccess,
  GIT_SYNC_FAILED_REDACTED_REASON,
  deliveryFor,
  type EventAccess,
} from '../events-delivery.js';
import type { ScopeCaller, ScopedDetail } from '../agent-tools/change-request-read.tools.js';

/**
 * The events route writes an event to a session only when the session's
 * person may read what it names. Two people watch one workspace: Alice may
 * read `Finance/`, Bob may not. Bob still hears everything outside it.
 */

const WS = 'main';
const FINANCE = 'knowledge-base/Finance/Budget.md';
const PUBLIC = 'knowledge-base/Public/Notes.md';
/** Request #7 changes only `Finance/`; #8 changes `Public/`. */
const FINANCE_REQUEST = 7;
const PUBLIC_REQUEST = 8;

const USERS: Record<string, { email: string; admin: boolean }> = {
  alice: { email: 'alice@example.com', admin: false },
  bob: { email: 'bob@example.com', admin: false },
  root: { email: 'root@example.com', admin: true },
};

/** Fake of the access service the file routes use, and of the change-request scope the tools use. */
function fakeAccess(): EventAccess & { grantBob: () => void; revokeBob: () => void } {
  let bobReadsFinance = false;
  const reads = (email: string, path: string) =>
    email !== USERS.bob!.email || bobReadsFinance || !path.includes('Finance/');
  return {
    grantBob: () => {
      bobReadsFinance = true;
    },
    revokeBob: () => {
      bobReadsFinance = false;
    },
    mayReadPath: async (_ws, email, path) => reads(email, path),
    mayReadRoot: async (_ws, email) => email !== USERS.bob!.email,
    maySeeChangeRequest: async (number, email) =>
      reads(email, number === FINANCE_REQUEST ? FINANCE : PUBLIC),
    mayShowChangeRequestPath: async (number, email, path) =>
      reads(email, number === FINANCE_REQUEST ? FINANCE : PUBLIC) && reads(email, path),
    isAdmin: async (email) => Object.values(USERS).some((u) => u.email === email && u.admin),
  };
}

const servers: HttpServer[] = [];
const streams: AbortController[] = [];
afterEach(() => {
  for (const s of streams.splice(0)) s.abort();
  for (const s of servers.splice(0)) s.close();
});

function listen(bus: WorkflowEventBus, access: EventAccess): string {
  const app = express();
  const auth: express.RequestHandler = (req, res, next) => {
    const user = USERS[String(req.headers['x-test-user'])];
    if (!user) {
      res.status(401).end();
      return;
    }
    req.userId = String(req.headers['x-test-user']);
    req.userEmail = user.email;
    next();
  };
  app.use('/api', createEventsRoutes(bus, auth, new EventDelivery(access)));
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Stream {
  events: WorkflowEvent[];
  /** Resolves once an event matching `pred` has arrived. */
  until: (pred: (e: WorkflowEvent) => boolean) => Promise<void>;
}

async function open(base: string, user: string, sessionId: string, lastEventId?: number): Promise<Stream> {
  const abort = new AbortController();
  streams.push(abort);
  const res = await fetch(`${base}/api/events?session=${sessionId}`, {
    headers: { 'x-test-user': user, ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}) },
    signal: abort.signal,
  });
  expect(res.status).toBe(200);
  const events: WorkflowEvent[] = [];
  const waiters: Array<{ pred: (e: WorkflowEvent) => boolean; resolve: () => void }> = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice('data: '.length)) as WorkflowEvent;
          events.push(event);
          for (const w of [...waiters]) {
            if (w.pred(event)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve();
            }
          }
        }
      }
    } catch {
      // aborted at teardown
    }
  })();
  return {
    events,
    until: (pred) =>
      events.some(pred) ? Promise.resolve() : new Promise((resolve) => waiters.push({ pred, resolve })),
  };
}

async function focus(base: string, user: string, sessionId: string): Promise<void> {
  const res = await fetch(`${base}/api/events/${sessionId}/focus`, {
    method: 'POST',
    headers: { 'x-test-user': user, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: WS }),
  });
  expect(res.status).toBe(200);
}

const fileChanged = (path: string): WorkflowEventPayload => ({
  kind: 'file-changed',
  workspaceId: WS,
  branch: WS,
  path,
  newSha: 'abc',
  byUserId: 'alice',
  byUserName: 'Alice',
});
const lockAcquired = (path: string): WorkflowEventPayload => ({
  kind: 'lock-acquired',
  workspaceId: WS,
  branch: WS,
  path,
  holderUserId: 'alice',
  holderName: 'Alice',
});
const lockReleased = (path: string): WorkflowEventPayload => ({ kind: 'lock-released', workspaceId: WS, branch: WS, path });
const approval = (number: number, path: string): WorkflowEventPayload => ({
  kind: 'approval-changed',
  number,
  path,
  approverUserId: 'alice',
  change: 'added',
});
const opened = (number: number): WorkflowEventPayload => ({
  kind: 'change-request-opened',
  number,
  source: 'alice/draft',
  target: 'main',
  authorIdHash: null,
  title: `Request ${number}`,
});
/** Something everybody on the workspace may have; once it arrives, everything emitted before it was judged. */
const SENTINEL: WorkflowEventPayload = { kind: 'fs-tree-changed', workspaceId: WS, branch: WS };
const isSentinel = (e: WorkflowEvent) => e.kind === 'fs-tree-changed';

/** Emit `payloads`, then the sentinel, and wait for it on every stream. */
async function emitAndSettle(bus: WorkflowEventBus, payloads: WorkflowEventPayload[], ...on: Stream[]) {
  for (const p of payloads) bus.emit(p);
  const sentinel = bus.emit(SENTINEL);
  await Promise.all(on.map((s) => s.until((e) => e.id === sentinel.id)));
}

const kinds = (s: Stream) => s.events.filter((e) => !isSentinel(e)).map((e) => `${e.kind}:${'path' in e ? e.path : 'number' in e ? e.number : ''}`);

describe('events route — delivery rule', () => {
  it('a write, a lock and an approval in a folder reach the reader of the folder, not the other person', async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const alice = await open(base, 'alice', 's-alice');
    const bob = await open(base, 'bob', 's-bob');
    await focus(base, 'alice', 's-alice');
    await focus(base, 'bob', 's-bob');

    await emitAndSettle(
      bus,
      [fileChanged(FINANCE), lockAcquired(FINANCE), lockReleased(FINANCE), approval(FINANCE_REQUEST, FINANCE)],
      alice,
      bob,
    );

    expect(kinds(alice)).toEqual([
      `file-changed:${FINANCE}`,
      `lock-acquired:${FINANCE}`,
      `lock-released:${FINANCE}`,
      `approval-changed:${FINANCE}`,
    ]);
    expect(kinds(bob)).toEqual([]);
  });

  it('a person keeps every event for what they may read, unchanged and in order', async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const bob = await open(base, 'bob', 's-bob');
    await focus(base, 'bob', 's-bob');

    const sent = [fileChanged(PUBLIC), lockAcquired(PUBLIC), lockReleased(PUBLIC), approval(PUBLIC_REQUEST, PUBLIC)];
    await emitAndSettle(bus, sent, bob);

    expect(bob.events.filter((e) => !isSentinel(e))).toEqual(sent.map((p) => expect.objectContaining(p)));
  });

  it('a request the person may not see produces no change-request-opened for them', async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const alice = await open(base, 'alice', 's-alice');
    const bob = await open(base, 'bob', 's-bob');
    await focus(base, 'alice', 's-alice');
    await focus(base, 'bob', 's-bob');

    await emitAndSettle(bus, [opened(FINANCE_REQUEST), opened(PUBLIC_REQUEST)], alice, bob);

    expect(kinds(alice)).toEqual([`change-request-opened:${FINANCE_REQUEST}`, `change-request-opened:${PUBLIC_REQUEST}`]);
    expect(kinds(bob)).toEqual([`change-request-opened:${PUBLIC_REQUEST}`]);
  });

  it('replay after a reconnect obeys the same rule', async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const before = bus.emit(SENTINEL);
    bus.emit(opened(FINANCE_REQUEST));
    bus.emit(approval(FINANCE_REQUEST, FINANCE));
    bus.emit(opened(PUBLIC_REQUEST));
    const last = bus.emit(approval(PUBLIC_REQUEST, PUBLIC));

    const alice = await open(base, 'alice', 's-alice', before.id);
    const bob = await open(base, 'bob', 's-bob', before.id);
    await Promise.all([alice, bob].map((s) => s.until((e) => e.id === last.id)));

    expect(kinds(alice)).toEqual([
      `change-request-opened:${FINANCE_REQUEST}`,
      `approval-changed:${FINANCE}`,
      `change-request-opened:${PUBLIC_REQUEST}`,
      `approval-changed:${PUBLIC}`,
    ]);
    expect(kinds(bob)).toEqual([`change-request-opened:${PUBLIC_REQUEST}`, `approval-changed:${PUBLIC}`]);
  });

  it('the focus list still decides which workspaces a session hears about', async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const alice = await open(base, 'alice', 's-alice');
    await focus(base, 'alice', 's-alice');

    bus.emit({ ...fileChanged(PUBLIC), workspaceId: 'elsewhere' } as WorkflowEventPayload);
    await emitAndSettle(bus, [], alice);

    expect(kinds(alice)).toEqual([]);
  });

  it('a grant shows on the next event, without a reconnect', async () => {
    const bus = new WorkflowEventBus();
    const access = fakeAccess();
    const base = listen(bus, access);
    const bob = await open(base, 'bob', 's-bob');
    await focus(base, 'bob', 's-bob');

    await emitAndSettle(bus, [fileChanged(FINANCE)], bob);
    access.grantBob();
    await emitAndSettle(bus, [fileChanged(FINANCE)], bob);

    expect(kinds(bob)).toEqual([`file-changed:${FINANCE}`]);
  });

  it('replay after a reconnect asks again: a revocation since the event was first delivered withholds it', async () => {
    const bus = new WorkflowEventBus();
    const access = fakeAccess();
    access.grantBob();
    const base = listen(bus, access);
    const bob = await open(base, 'bob', 's-bob');
    await focus(base, 'bob', 's-bob');
    const before = bus.emit(SENTINEL);
    // Kinds the focus list does not scope, so the replay reaches the rule. The
    // public request is the control: Bob keeps it, so the replay did run.
    await emitAndSettle(
      bus,
      [opened(FINANCE_REQUEST), approval(FINANCE_REQUEST, FINANCE), opened(PUBLIC_REQUEST)],
      bob,
    );
    expect(kinds(bob)).toEqual([
      `change-request-opened:${FINANCE_REQUEST}`,
      `approval-changed:${FINANCE}`,
      `change-request-opened:${PUBLIC_REQUEST}`,
    ]);

    access.revokeBob();
    const again = await open(base, 'bob', 's-bob', before.id);
    await focus(base, 'bob', 's-bob');
    const last = bus.emit(SENTINEL);
    await again.until((e) => e.id === last.id);

    expect(kinds(again)).toEqual([`change-request-opened:${PUBLIC_REQUEST}`]);
  });

  it("an agent's tool call reaches its own person and admins through the route, nobody else", async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const alice = await open(base, 'alice', 's-alice');
    const bob = await open(base, 'bob', 's-bob');
    const root = await open(base, 'root', 's-root');
    for (const [user, s] of [['alice', 's-alice'], ['bob', 's-bob'], ['root', 's-root']] as const) await focus(base, user, s);

    await emitAndSettle(
      bus,
      [{ kind: 'agent-tool-call', forUserId: 'alice', threadId: 't', tool: 'write_file', summary: `writing ${FINANCE}` }],
      alice,
      bob,
      root,
    );

    const toolCalls = (s: Stream) => s.events.filter((e) => e.kind === 'agent-tool-call');
    expect(toolCalls(alice)).toHaveLength(1);
    expect(toolCalls(root)).toHaveLength(1);
    expect(toolCalls(bob)).toEqual([]);
  });

  it("asks once per session whether its person is an admin, not once per other person's tool call", async () => {
    const bus = new WorkflowEventBus();
    const base0 = fakeAccess();
    const asked: string[] = [];
    const access: EventAccess = { ...base0, isAdmin: async (email) => (asked.push(email), base0.isAdmin(email)) };
    const base = listen(bus, access);
    const bob = await open(base, 'bob', 's-bob');
    await focus(base, 'bob', 's-bob');

    const call = (n: number): WorkflowEventPayload => ({ kind: 'agent-tool-call', forUserId: 'alice', threadId: 't', tool: 'write_file', summary: `call ${n}` });
    await emitAndSettle(bus, [call(1), call(2), call(3)], bob);

    expect(bob.events.filter((e) => e.kind === 'agent-tool-call')).toEqual([]);
    expect(asked).toEqual([USERS.bob!.email]);
  });

  it('fans one event out to 100 sessions through the route, each getting what it may read', async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const sessions = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        const user = i % 2 ? 'bob' : 'alice';
        const stream = await open(base, user, `s-${i}`);
        await focus(base, user, `s-${i}`);
        return stream;
      }),
    );
    await emitAndSettle(bus, [], ...sessions); // every stream is live

    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      await emitAndSettle(bus, [fileChanged(FINANCE)], ...sessions);
      samples.push(performance.now() - start);
    }
    // Measured and reported, not asserted: this times HTTP writes and the
    // test client's parsing as well as the check, and under a loaded suite
    // that is noise. The check's own 50 ms budget is pinned in `deliveryFor`
    // below, without a socket in the way.
    const { median, max } = spread(samples);
    console.log(`100-session fan-out through the route: median ${median.toFixed(2)} ms, max ${max.toFixed(2)} ms per event`);
    expect(sessions.filter((s) => s.events.some((e) => e.kind === 'file-changed'))).toHaveLength(50);
  });

  it("git-sync-failed carries git's words only to who may read the root", async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const alice = await open(base, 'alice', 's-alice');
    const bob = await open(base, 'bob', 's-bob');
    await focus(base, 'alice', 's-alice');
    await focus(base, 'bob', 's-bob');

    await emitAndSettle(
      bus,
      [{ kind: 'git-sync-failed', workspaceId: WS, branch: WS, reason: 'conflict in Finance/Budget.md', conflictedPaths: [FINANCE] }],
      alice,
      bob,
    );

    const forAlice = alice.events.find((e) => e.kind === 'git-sync-failed');
    const forBob = bob.events.find((e) => e.kind === 'git-sync-failed');
    expect(forAlice).toMatchObject({ reason: 'conflict in Finance/Budget.md', conflictedPaths: [FINANCE] });
    expect(forBob).toMatchObject({ kind: 'git-sync-failed', workspaceId: WS, branch: WS, reason: GIT_SYNC_FAILED_REDACTED_REASON });
    expect(forBob).not.toHaveProperty('conflictedPaths');
  });
});

describe('deliveryFor', () => {
  const stamp = (p: WorkflowEventPayload, id = 1): WorkflowEvent => ({ id, ts: '2026-10-19T00:00:00.000Z', ...p }) as WorkflowEvent;
  const toolCall = stamp({ kind: 'agent-tool-call', forUserId: 'alice', threadId: 't', tool: 'write_file', summary: `writing ${FINANCE}` });

  it('agent-tool-call reaches the person whose agent made the call, and admins, nobody else', async () => {
    const access = fakeAccess();
    expect(await deliveryFor(toolCall, { userId: 'alice', email: USERS.alice!.email }, access)).toBe(toolCall);
    expect(await deliveryFor(toolCall, { userId: 'root', email: USERS.root!.email }, access)).toBe(toolCall);
    expect(await deliveryFor(toolCall, { userId: 'bob', email: USERS.bob!.email }, access)).toBeNull();
  });

  it('withholds when a verdict cannot be reached', async () => {
    const failing: EventAccess = {
      ...fakeAccess(),
      mayReadPath: () => Promise.reject(new Error('access tree unreadable')),
      mayReadRoot: () => Promise.reject(new Error('access tree unreadable')),
    };
    const viewer = { userId: 'alice', email: USERS.alice!.email };
    expect(await deliveryFor(stamp(fileChanged(PUBLIC)), viewer, failing)).toBeNull();
    expect(
      await deliveryFor(stamp({ kind: 'git-sync-failed', workspaceId: WS, branch: WS, reason: 'git said' }), viewer, failing),
    ).toMatchObject({ reason: GIT_SYNC_FAILED_REDACTED_REASON });
  });

  it('withholds a named thing from a session with no email', async () => {
    expect(await deliveryFor(stamp(fileChanged(PUBLIC)), { userId: 'x', email: undefined }, fakeAccess())).toBeNull();
  });

  it('delivers kinds that name nothing as they are', async () => {
    const merged = stamp({ kind: 'change-request-merged', number: FINANCE_REQUEST });
    expect(await deliveryFor(merged, { userId: 'bob', email: USERS.bob!.email }, fakeAccess())).toBe(merged);
  });

  it('judges a 100-session fan-out in under 50 ms per event', async () => {
    // A verdict that costs a real async hop each time, one person per session
    // so the per-person memo saves nothing: the worst case of the check.
    const base = fakeAccess();
    const access: EventAccess = {
      ...base,
      mayReadPath: (ws, email, path) => new Promise((r) => setImmediate(() => r(base.mayReadPath(ws, email, path)))),
    };
    const delivery = new EventDelivery(access);
    const viewers = Array.from({ length: 100 }, (_, i) => ({ userId: `u${i}`, email: i % 2 ? USERS.bob!.email : `u${i}@example.com` }));
    const samples: number[] = [];
    for (let id = 1; id <= 20; id++) {
      const event = stamp(fileChanged(id % 2 ? FINANCE : PUBLIC), id);
      const start = performance.now();
      const verdicts = await Promise.all(viewers.map((v) => delivery.judge(event, v)));
      samples.push(performance.now() - start);
      expect(verdicts.filter(Boolean)).toHaveLength(id % 2 ? 50 : 100);
    }
    const { median, max } = spread(samples);
    console.log(`100-session verdicts: median ${median.toFixed(2)} ms, max ${max.toFixed(2)} ms per event`);
    expect(median).toBeLessThan(50);
  });

  it('judges one person once per event, however many tabs they have', async () => {
    let calls = 0;
    const access: EventAccess = { ...fakeAccess(), mayReadPath: async () => (calls++, true) };
    const delivery = new EventDelivery(access);
    const event = stamp(fileChanged(PUBLIC));
    const viewer = { userId: 'alice', email: USERS.alice!.email };
    await Promise.all([delivery.judge(event, viewer), delivery.judge(event, viewer), delivery.judge(event, viewer)]);
    expect(calls).toBe(1);
    await delivery.judge(stamp(fileChanged(PUBLIC), 2), viewer);
    expect(calls).toBe(2);
  });

  it('never reuses a settled verdict: judging the same event again asks again', async () => {
    const access = fakeAccess();
    access.grantBob();
    const delivery = new EventDelivery(access);
    const event = stamp(fileChanged(FINANCE));
    const bob = { userId: 'bob', email: USERS.bob!.email };
    expect(await delivery.judge(event, bob)).toBe(event);
    access.revokeBob();
    expect(await delivery.judge(event, bob)).toBeNull();
  });
});

describe('createEventAccess', () => {
  const calls: string[] = [];
  const access = createEventAccess({
    accessControl: {
      canRead: async (ws, email, rel) => (calls.push(`${ws}|${email}|${rel}`), !rel.startsWith('Finance/')),
    },
    adminAccess: { isAdmin: async (email) => email === USERS.root!.email },
    kbDirName: 'knowledge-base',
    scopedDetail: async (caller, number) => {
      if (number === FINANCE_REQUEST && caller.user.email === USERS.bob!.email) throw new Error('404');
      return { mayShow: (path: string) => path !== 'hidden.md' } as ScopedDetail;
    },
    maySee: async (caller, number) => !(number === FINANCE_REQUEST && caller.user.email === USERS.bob!.email),
    services: {} as Omit<ScopeCaller, 'user'>,
  });

  it('judges a path as the file routes do: repo-relative inside the KB, open outside it', async () => {
    expect(await access.mayReadPath(WS, 'a@x', FINANCE)).toBe(false);
    expect(await access.mayReadPath(WS, 'a@x', PUBLIC)).toBe(true);
    expect(await access.mayReadPath(WS, 'a@x', '.hexis/state.json')).toBe(true);
    expect(await access.mayReadRoot(WS, 'a@x')).toBe(true);
    expect(calls).toEqual([`${WS}|a@x|Finance/Budget.md`, `${WS}|a@x|Public/Notes.md`, `${WS}|a@x|`]);
  });

  it("judges a request's path by the tools' scope, a hidden request refusing", async () => {
    expect(await access.mayShowChangeRequestPath(PUBLIC_REQUEST, USERS.bob!.email, PUBLIC)).toBe(true);
    expect(await access.mayShowChangeRequestPath(PUBLIC_REQUEST, USERS.bob!.email, 'hidden.md')).toBe(false);
    await expect(access.mayShowChangeRequestPath(FINANCE_REQUEST, USERS.bob!.email, FINANCE)).rejects.toThrow();
    expect(await access.maySeeChangeRequest(FINANCE_REQUEST, USERS.bob!.email)).toBe(false);
  });
});

function spread(samples: number[]): { median: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}
