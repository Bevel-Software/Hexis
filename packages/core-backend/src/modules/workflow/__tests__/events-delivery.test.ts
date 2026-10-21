import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowEvent, WorkflowEventPayload } from '@bevel-software/platform-shared';
import {
  WorkflowEventBus,
  createEventsRoutes,
  EventDelivery,
  createEventAccess,
  type EventAccess,
  type EventViewer,
} from '../index.js';

/** What a `git-sync-failed` says in place of git's words. */
const REDACTED_REASON = 'The last push did not land.';

/**
 * The events route writes an event to a session only when the session's
 * person may read what it names. Two people watch one workspace: Alice may
 * read `Finance/`, Bob may not. Bob still hears everything outside it.
 */

const WS = 'main';
const FINANCE = 'knowledge-base/Finance/Budget.md';
const PUBLIC = 'knowledge-base/Public/Notes.md';
/** The same two files as a request names them: KB-repo-relative. */
const FINANCE_REPO = 'Finance/Budget.md';
const PUBLIC_REPO = 'Public/Notes.md';
/** Request #7 changes only `Finance/`; #8 changes `Public/`. */
const FINANCE_REQUEST = 7;
const PUBLIC_REQUEST = 8;

const USERS: Record<string, { email: string }> = {
  alice: { email: 'alice@example.com' },
  bob: { email: 'bob@example.com' },
  /** A deployment admin. Admin status grants nothing here: events are about what a person may read. */
  root: { email: 'root@example.com' },
  /** Reads the root, like Alice, but not `Finance/`: a folder denied below a readable root. */
  carol: { email: 'carol@example.com' },
};

/** Fake of the access service the file routes use, and of the change-request scope the tools use. */
function fakeAccess(): EventAccess & { grantBob: () => void; revokeBob: () => void } {
  let bobReadsFinance = false;
  const reads = (email: string, path: string) =>
    !path.includes('Finance/') || (email === USERS.bob!.email ? bobReadsFinance : email !== USERS.carol!.email);
  return {
    grantBob: () => {
      bobReadsFinance = true;
    },
    revokeBob: () => {
      bobReadsFinance = false;
    },
    mayReadPath: async (_ws, email, path) => reads(email, path),
    mayReadRepoPath: async (_ws, email, repoPath) =>
      repoPath === '' ? email !== USERS.bob!.email : reads(email, `knowledge-base/${repoPath}`),
    mayReadAtTarget: async (_target, email, repoPath) => reads(email, `knowledge-base/${repoPath}`),
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
  targetBranch: 'main',
  approverUserId: 'alice',
  change: 'added',
});
const opened = (number: number): WorkflowEventPayload => ({
  kind: 'change-request-opened',
  number,
  source: 'alice/draft',
  target: 'main',
  authorIdHash: null,
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
      [fileChanged(FINANCE), lockAcquired(FINANCE), lockReleased(FINANCE), approval(FINANCE_REQUEST, FINANCE_REPO)],
      alice,
      bob,
    );

    expect(kinds(alice)).toEqual([
      `file-changed:${FINANCE}`,
      `lock-acquired:${FINANCE}`,
      `lock-released:${FINANCE}`,
      `approval-changed:${FINANCE_REPO}`,
    ]);
    expect(kinds(bob)).toEqual([]);
  });

  it('a person keeps every event for what they may read, unchanged and in order', async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const bob = await open(base, 'bob', 's-bob');
    await focus(base, 'bob', 's-bob');

    const sent = [fileChanged(PUBLIC), lockAcquired(PUBLIC), lockReleased(PUBLIC), approval(PUBLIC_REQUEST, PUBLIC_REPO)];
    await emitAndSettle(bus, sent, bob);

    expect(bob.events.filter((e) => !isSentinel(e))).toEqual(sent.map((p) => expect.objectContaining(p)));
  });

  it('a new request is announced to everyone, and says nothing a person may not read: a number and branches, no title, no paths', async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const alice = await open(base, 'alice', 's-alice');
    const bob = await open(base, 'bob', 's-bob');
    await focus(base, 'alice', 's-alice');
    await focus(base, 'bob', 's-bob');

    await emitAndSettle(bus, [opened(FINANCE_REQUEST), opened(PUBLIC_REQUEST)], alice, bob);

    expect(kinds(alice)).toEqual([`change-request-opened:${FINANCE_REQUEST}`, `change-request-opened:${PUBLIC_REQUEST}`]);
    expect(kinds(bob)).toEqual([`change-request-opened:${FINANCE_REQUEST}`, `change-request-opened:${PUBLIC_REQUEST}`]);
    // What Bob, who may not read `Finance/`, was handed of the request into it.
    const announced = bob.events.find((e) => e.kind === 'change-request-opened' && e.number === FINANCE_REQUEST)!;
    expect(Object.keys(announced).sort()).toEqual(['authorIdHash', 'id', 'kind', 'number', 'source', 'target', 'ts']);
  });

  it('replay after a reconnect obeys the same rule', async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const before = bus.emit(SENTINEL);
    bus.emit(opened(FINANCE_REQUEST));
    bus.emit(approval(FINANCE_REQUEST, FINANCE_REPO));
    bus.emit(opened(PUBLIC_REQUEST));
    const last = bus.emit(approval(PUBLIC_REQUEST, PUBLIC_REPO));

    const alice = await open(base, 'alice', 's-alice', before.id);
    const bob = await open(base, 'bob', 's-bob', before.id);
    await Promise.all([alice, bob].map((s) => s.until((e) => e.id === last.id)));

    expect(kinds(alice)).toEqual([
      `change-request-opened:${FINANCE_REQUEST}`,
      `approval-changed:${FINANCE_REPO}`,
      `change-request-opened:${PUBLIC_REQUEST}`,
      `approval-changed:${PUBLIC_REPO}`,
    ]);
    // The announcements reach Bob; the approval of a file he may not read does not.
    expect(kinds(bob)).toEqual([
      `change-request-opened:${FINANCE_REQUEST}`,
      `change-request-opened:${PUBLIC_REQUEST}`,
      `approval-changed:${PUBLIC_REPO}`,
    ]);
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
    // announcement is the control: Bob keeps it, so the replay did run.
    await emitAndSettle(
      bus,
      [approval(FINANCE_REQUEST, FINANCE_REPO), opened(PUBLIC_REQUEST)],
      bob,
    );
    expect(kinds(bob)).toEqual([
      `approval-changed:${FINANCE_REPO}`,
      `change-request-opened:${PUBLIC_REQUEST}`,
    ]);

    access.revokeBob();
    const again = await open(base, 'bob', 's-bob', before.id);
    await focus(base, 'bob', 's-bob');
    const last = bus.emit(SENTINEL);
    await again.until((e) => e.id === last.id);

    expect(kinds(again)).toEqual([`change-request-opened:${PUBLIC_REQUEST}`]);
  });

  it("an agent's tool call reaches its own person through the route, nobody else — an admin included", async () => {
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
    expect(toolCalls(root)).toEqual([]);
    expect(toolCalls(bob)).toEqual([]);
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
    // that is noise. The check's own 50 ms budget is pinned in `EventDelivery`
    // below, without a socket in the way.
    const { median, max } = spread(samples);
    console.log(`100-session fan-out through the route: median ${median.toFixed(2)} ms, max ${max.toFixed(2)} ms per event`);
    expect(sessions.filter((s) => s.events.some((e) => e.kind === 'file-changed'))).toHaveLength(50);
  });

  it("git-sync-failed carries git's words only to who may read the root and every conflicted file", async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const people = ['alice', 'bob', 'carol'] as const;
    const [alice, bob, carol] = await Promise.all(people.map((u) => open(base, u, `s-${u}`)));
    for (const u of people) await focus(base, u, `s-${u}`);

    // A sync conflict's reason quotes its files, as `syncConflictMessage` does;
    // `conflictedPaths` are KB-repo-relative.
    const reason = 'main is not in sync yet: Finance/Budget.md, Public/Notes.md changed both in Hexis and on the git host.';
    await emitAndSettle(
      bus,
      [{ kind: 'git-sync-failed', workspaceId: WS, branch: WS, reason, conflictedPaths: ['Finance/Budget.md', 'Public/Notes.md'] }],
      alice!,
      bob!,
      carol!,
    );

    const failure = (s: Stream) => s.events.find((e) => e.kind === 'git-sync-failed');
    expect(failure(alice!)).toMatchObject({ reason, conflictedPaths: ['Finance/Budget.md', 'Public/Notes.md'] });
    // Carol reads the root but not `Finance/`: the reason would name its file.
    expect(failure(carol!)).toEqual(
      expect.objectContaining({ workspaceId: WS, branch: WS, reason: REDACTED_REASON, conflictedPaths: ['Public/Notes.md'] }),
    );
    // Bob may not read the root: never git's words, and only the files he may read.
    expect(failure(bob!)).toEqual(
      expect.objectContaining({ workspaceId: WS, branch: WS, reason: REDACTED_REASON, conflictedPaths: ['Public/Notes.md'] }),
    );
  });

  it('git-sync-failed with no conflict keeps its sentence for a root reader and redacts it for the rest', async () => {
    const bus = new WorkflowEventBus();
    const base = listen(bus, fakeAccess());
    const carol = await open(base, 'carol', 's-carol');
    const bob = await open(base, 'bob', 's-bob');
    await focus(base, 'carol', 's-carol');
    await focus(base, 'bob', 's-bob');

    await emitAndSettle(bus, [{ kind: 'git-sync-failed', workspaceId: WS, branch: WS, reason: 'The host refused the push.' }], carol, bob);

    expect(carol.events.find((e) => e.kind === 'git-sync-failed')).toMatchObject({ reason: 'The host refused the push.' });
    const forBob = bob.events.find((e) => e.kind === 'git-sync-failed');
    expect(forBob).toMatchObject({ reason: REDACTED_REASON });
    expect(forBob).not.toHaveProperty('conflictedPaths');
  });
});

describe('EventDelivery', () => {
  const judge = (event: WorkflowEvent, viewer: EventViewer, access: EventAccess) => new EventDelivery(access).judge(event, viewer);
  const stamp = (p: WorkflowEventPayload, id = 1): WorkflowEvent => ({ id, ts: '2026-10-19T00:00:00.000Z', ...p }) as WorkflowEvent;
  const toolCall = stamp({ kind: 'agent-tool-call', forUserId: 'alice', threadId: 't', tool: 'write_file', summary: `writing ${FINANCE}` });

  it('agent-tool-call reaches the person whose agent made the call, nobody else', async () => {
    const access = fakeAccess();
    expect(await judge(toolCall, { userId: 'alice', email: USERS.alice!.email }, access)).toBe(toolCall);
    expect(await judge(toolCall, { userId: 'root', email: USERS.root!.email }, access)).toBeNull();
    expect(await judge(toolCall, { userId: 'bob', email: USERS.bob!.email }, access)).toBeNull();
  });

  it('withholds when a verdict cannot be reached', async () => {
    const failing: EventAccess = {
      ...fakeAccess(),
      mayReadPath: () => Promise.reject(new Error('access tree unreadable')),
      mayReadRepoPath: () => Promise.reject(new Error('access tree unreadable')),
    };
    const viewer = { userId: 'alice', email: USERS.alice!.email };
    expect(await judge(stamp(fileChanged(PUBLIC)), viewer, failing)).toBeNull();
    expect(
      await judge(stamp({ kind: 'git-sync-failed', workspaceId: WS, branch: WS, reason: 'git said' }), viewer, failing),
    ).toMatchObject({ reason: REDACTED_REASON });
  });

  it('withholds a named thing from a session with no email', async () => {
    expect(await judge(stamp(fileChanged(PUBLIC)), { userId: 'x', email: undefined }, fakeAccess())).toBeNull();
  });

  it('delivers kinds that name nothing as they are', async () => {
    const merged = stamp({ kind: 'change-request-merged', number: FINANCE_REQUEST });
    expect(await judge(merged, { userId: 'bob', email: USERS.bob!.email }, fakeAccess())).toBe(merged);
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
  const atRef: string[] = [];
  /** The branches the server holds a checkout of: `main` yes, `release` no. */
  const checkedOut = new Set([WS]);
  const access = createEventAccess({
    accessControl: {
      canRead: async (ws, email, rel) => (calls.push(`${ws}|${email}|${rel}`), !rel.startsWith('Finance/')),
      canReadBatchAtRef: async (ws, ref, email, paths) => {
        atRef.push(`${ws}|${ref}|${email}|${paths.join(',')}`);
        if (ref === 'origin/gone') return null;
        return new Map(paths.map((p) => [p, !p.startsWith('Finance/')]));
      },
    },
    kbDirName: 'knowledge-base',
    workspaces: {
      hasWorkspace: async (workspaceId) => checkedOut.has(workspaceId),
      anyWorkspaceId: async () => WS,
    },
  });

  it('judges a path as the file routes do: repo-relative inside the KB, open outside it', async () => {
    expect(await access.mayReadPath(WS, 'a@x', FINANCE)).toBe(false);
    expect(await access.mayReadPath(WS, 'a@x', PUBLIC)).toBe(true);
    expect(await access.mayReadPath(WS, 'a@x', '.hexis/state.json')).toBe(true);
    expect(await access.mayReadRepoPath(WS, 'a@x', '')).toBe(true);
    expect(await access.mayReadRepoPath(WS, 'a@x', 'Finance/Budget.md')).toBe(false);
    expect(calls).toEqual([`${WS}|a@x|Finance/Budget.md`, `${WS}|a@x|Public/Notes.md`, `${WS}|a@x|`, `${WS}|a@x|Finance/Budget.md`]);
  });

  it("judges an approved path from the target branch's own checkout when the server holds one — a disk read, no git", async () => {
    calls.length = 0;
    expect(await access.mayReadAtTarget('main', 'a@x', PUBLIC_REPO)).toBe(true);
    expect(await access.mayReadAtTarget('main', 'a@x', FINANCE_REPO)).toBe(false);
    expect(calls).toEqual([`${WS}|a@x|${PUBLIC_REPO}`, `${WS}|a@x|${FINANCE_REPO}`]);
    expect(atRef).toEqual([]);
  });

  it('falls back to the published ref, in any clone, for a target with no checkout — and grants nothing on a ref that does not resolve', async () => {
    calls.length = 0;
    expect(await access.mayReadAtTarget('release', 'a@x', PUBLIC_REPO)).toBe(true);
    expect(await access.mayReadAtTarget('release', 'a@x', FINANCE_REPO)).toBe(false);
    expect(await access.mayReadAtTarget('gone', 'a@x', PUBLIC_REPO)).toBe(false);
    expect(calls).toEqual([]);
    expect(atRef).toEqual([
      `${WS}|origin/release|a@x|${PUBLIC_REPO}`,
      `${WS}|origin/release|a@x|${FINANCE_REPO}`,
      `${WS}|origin/gone|a@x|${PUBLIC_REPO}`,
    ]);
  });
});

function spread(samples: number[]): { median: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}
