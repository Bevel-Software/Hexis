import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { WorkflowEventBus } from '../event-bus.js';
import { createEventsRoutes, type EventReadGate } from '../events.routes.js';

/**
 * `document-unreadable` names a file and quotes its parser, so the events
 * route delivers it only to sessions whose person may read that file, while
 * every other kind flows as before, in order.
 */

const DAMAGED = 'knowledge-base/Legal/Supplier-Agreement.pdf';

/** The signed-in user is whoever the `x-user` header says. */
const auth: RequestHandler = (req, _res, next) => {
  req.userId = String(req.headers['x-user'] ?? '');
  next();
};

let bus: WorkflowEventBus;
let server: HttpServer;
let base = '';
let asked: Array<[string, string, string]> = [];
const streams: AbortController[] = [];

async function start(mayRead?: EventReadGate): Promise<void> {
  bus = new WorkflowEventBus();
  const app = express();
  app.use('/api', createEventsRoutes(bus, auth, mayRead));
  server = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  asked = [];
});
afterEach(async () => {
  for (const c of streams.splice(0)) c.abort();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Open a session's stream, focus it on `main`, and collect what it is sent. */
async function openSession(user: string, sessionId: string) {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(`${base}/api/events?session=${sessionId}`, {
    headers: { 'x-user': user },
    signal: controller.signal,
  });
  const received: WorkflowEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffered.indexOf('\n\n')) >= 0) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (data) received.push(JSON.parse(data.slice(6)) as WorkflowEvent);
        }
      }
    } catch {
      // aborted at teardown
    }
  })();
  const focus = await fetch(`${base}/api/events/${sessionId}/focus`, {
    method: 'POST',
    headers: { 'x-user': user, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'main' }),
  });
  expect(focus.status).toBe(200);
  return { received };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

/** Only `reader@x` may read the damaged file. */
const gate: EventReadGate = async (userId, workspaceId, path) => {
  asked.push([userId, workspaceId, path]);
  // Slow enough that an event emitted after it would overtake it, were order not kept.
  await new Promise((r) => setTimeout(r, 30));
  return userId === 'reader@x';
};

function emitFailureThenChange(): void {
  bus.emit({ kind: 'document-unreadable', workspaceId: 'main', path: DAMAGED, reason: 'extracting its text took longer than 10 seconds' });
  bus.emit({ kind: 'fs-tree-changed', workspaceId: 'main', branch: 'main' });
}

describe('events route — a read-gated kind', () => {
  it('reaches a session whose person may read the file, in order with what follows it', async () => {
    await start(gate);
    const reader = await openSession('reader@x', 's-reader');
    emitFailureThenChange();
    await settle();
    expect(reader.received.map((e) => e.kind)).toEqual(['document-unreadable', 'fs-tree-changed']);
    expect(reader.received[0]).toMatchObject({ path: DAMAGED, reason: 'extracting its text took longer than 10 seconds' });
    expect(asked).toEqual([['reader@x', 'main', DAMAGED]]);
  });

  it('never reaches a session on the same workspace whose person may not read it — other events still do', async () => {
    await start(gate);
    const outsider = await openSession('outsider@x', 's-outsider');
    emitFailureThenChange();
    await settle();
    expect(outsider.received.map((e) => e.kind)).toEqual(['fs-tree-changed']);
  });

  it('reaches no one when the route was given no read gate — the rule fails closed', async () => {
    await start(undefined);
    const reader = await openSession('reader@x', 's-nogate');
    emitFailureThenChange();
    await settle();
    expect(reader.received.map((e) => e.kind)).toEqual(['fs-tree-changed']);
  });

  it('reaches no one whose read check fails', async () => {
    await start(async () => {
      throw new Error('access rules unavailable');
    });
    const reader = await openSession('reader@x', 's-broken');
    emitFailureThenChange();
    await settle();
    expect(reader.received.map((e) => e.kind)).toEqual(['fs-tree-changed']);
  });
});
