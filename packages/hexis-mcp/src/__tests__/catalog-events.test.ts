import http from 'node:http';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { HexisMcpConfig } from '../config.js';
import { subscribeCatalogEvents } from '../catalog-events.js';

/**
 * The subscription that lets an IDLE connection hear about a commit.
 *
 * `catalog-watch.ts` checks on activity, which is right for a connection in
 * use and silent for one that is not — and a person who commits a `.tool` and
 * waits is exactly the second case. A timer would cover it and was taken out
 * twice, because two seconds per idle laptop is a load that scales with
 * laptops. This asks the deployment NOTHING: it parks one request and reads
 * what comes back.
 *
 * So what is asserted here is mostly restraint under a network that misbehaves
 * — a stream that ends, a deployment that refuses, a frame split across two
 * reads, a proxy that sends something that is not ours — because every one of
 * those, mishandled, is either a silent connection or a hot loop against
 * someone's deployment.
 */

let server: http.Server | null = null;
let base = '';
/** Every open stream, and every open ATTEMPT with its bearer. */
const streams = new Set<http.ServerResponse>();
const opens: (string | undefined)[] = [];
/** What the next open answers with; `null` is the normal event stream. */
let refuseWith: number | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] !== '/api/agent/catalog-events') {
      res.writeHead(404).end();
      return;
    }
    opens.push(req.headers.authorization);
    if (refuseWith !== null) {
      res.writeHead(refuseWith, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    // Node holds the head until something is written, and the real route's own
    // `flushHeaders()` is what stops that. Without a flush here the
    // subscriber's `fetch` would not resolve until the first announcement, and
    // every assertion about an already-OPEN stream would be measuring the
    // wrong moment.
    res.write(':\n\n');
    streams.add(res);
    res.on('close', () => streams.delete(res));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

afterEach(() => {
  for (const stream of streams) stream.end();
  streams.clear();
  opens.length = 0;
  refuseWith = null;
  vi.restoreAllMocks();
});

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, what: string, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(10);
  }
};

/** Write one revision frame into every open stream, as the deployment does. */
const announce = (revision: string): void => {
  for (const stream of streams) stream.write(`event: revision\ndata: ${JSON.stringify({ revision })}\n\n`);
};

const config = (): HexisMcpConfig => ({ baseUrl: base, connectionKey: 'bevel_test' });

describe('subscribeCatalogEvents', () => {
  it('hands over every revision the deployment announces, in order', async () => {
    const seen: string[] = [];
    const sub = subscribeCatalogEvents({ config: config(), onRevision: (r) => void seen.push(r) });
    try {
      await waitFor(() => streams.size > 0, 'the stream to open');
      announce('rev-2');
      announce('rev-3');
      await waitFor(() => seen.length === 2, 'both revisions');

      expect(seen).toEqual(['rev-2', 'rev-3']);
      expect(opens).toEqual(['Bearer bevel_test']);
    } finally {
      sub.stop();
    }
  });

  it('reads a frame that arrived in pieces', async () => {
    const seen: string[] = [];
    const sub = subscribeCatalogEvents({ config: config(), onRevision: (r) => void seen.push(r) });
    try {
      await waitFor(() => streams.size > 0, 'the stream to open');
      // A fingerprint split across two TCP reads is ordinary, not an error —
      // and a parser that treated the first half as a frame would hand the
      // caller a revision that does not exist.
      for (const stream of streams) stream.write('event: revision\ndata: {"revi');
      await settle(50);
      expect(seen).toEqual([]);
      for (const stream of streams) stream.write('sion":"rev-9"}\n\n');

      await waitFor(() => seen.length === 1, 'the reassembled revision');
      expect(seen).toEqual(['rev-9']);
    } finally {
      sub.stop();
    }
  });

  it('ignores a keep-alive and anything that is not a revision', async () => {
    const seen: string[] = [];
    const sub = subscribeCatalogEvents({ config: config(), onRevision: (r) => void seen.push(r) });
    try {
      await waitFor(() => streams.size > 0, 'the stream to open');
      for (const stream of streams) {
        stream.write(':\n\n'); // the 25-second keep-alive
        stream.write('event: something-new\ndata: {"unrelated":true}\n\n');
        stream.write('event: revision\ndata: not json\n\n');
        stream.write('event: revision\ndata: {"revision":""}\n\n');
      }
      announce('rev-2');
      await waitFor(() => seen.length === 1, 'the one real revision');
      await settle(50);

      // Shape drift is NOT a change: a subscriber that read an absent or
      // empty field as a new revision would re-register the entire toolset on
      // every keep-alive.
      expect(seen).toEqual(['rev-2']);
    } finally {
      sub.stop();
    }
  });

  it('reopens when the stream ends, and says so once', async () => {
    const log = vi.fn();
    const seen: string[] = [];
    const sub = subscribeCatalogEvents({
      config: config(),
      onRevision: (r) => void seen.push(r),
      log,
      reconnectBaseMs: 10,
    });
    try {
      await waitFor(() => streams.size > 0, 'the stream to open');
      // A deployment redeploying, a proxy's idle cap, a laptop waking: all
      // arrive here as a stream that simply ended.
      for (const stream of streams) stream.end();
      streams.clear();

      await waitFor(() => streams.size > 0, 'the stream to reopen');
      announce('rev-after-reconnect');
      await waitFor(() => seen.length === 1, 'a revision on the new stream');

      expect(seen).toEqual(['rev-after-reconnect']);
      expect(opens.length).toBeGreaterThan(1);
    } finally {
      sub.stop();
    }
  });

  it('backs off against a deployment that refuses, and writes one line for the streak', async () => {
    refuseWith = 503;
    const log = vi.fn();
    const sub = subscribeCatalogEvents({
      config: config(),
      onRevision: vi.fn(),
      log,
      reconnectBaseMs: 10,
      reconnectMaxMs: 40,
    });
    try {
      await waitFor(() => opens.length >= 3, 'a few refused attempts');

      // A deployment that is down for an hour must not write a line per
      // attempt: the operator needs to find the useful one.
      const complaints = log.mock.calls.flat().filter((line) => String(line).includes('stream dropped'));
      expect(complaints).toHaveLength(1);
      expect(String(complaints[0])).toContain('503');

      // …and when it comes back, it says so, and the announcements resume.
      refuseWith = null;
      await waitFor(() => streams.size > 0, 'the stream to open once the deployment is back');
      await waitFor(
        () => log.mock.calls.flat().some((line) => String(line).includes('streaming catalog changes again')),
        'the recovery line',
      );
    } finally {
      sub.stop();
    }
  });

  it('reopens with the credential renewal arrived at, not the one it started with', async () => {
    const cfg = config();
    const sub = subscribeCatalogEvents({ config: cfg, onRevision: vi.fn(), reconnectBaseMs: 10 });
    try {
      await waitFor(() => streams.size > 0, 'the stream to open');
      // Renewal replaces the key on the shared config object. Reopening with
      // the retired one is how a subscription would 401 forever against a
      // perfectly good deployment.
      cfg.connectionKey = 'bevel_renewed';
      for (const stream of streams) stream.end();
      streams.clear();

      await waitFor(() => opens.length > 1, 'the reopen');
      expect(opens.at(-1)).toBe('Bearer bevel_renewed');
    } finally {
      sub.stop();
    }
  });

  it('stops for good, and hands over nothing after it', async () => {
    const seen: string[] = [];
    const sub = subscribeCatalogEvents({
      config: config(),
      onRevision: (r) => void seen.push(r),
      reconnectBaseMs: 10,
    });
    await waitFor(() => streams.size > 0, 'the stream to open');
    sub.stop();
    const atStop = opens.length;

    // Teardown has to actually END the read — a stop that only set a flag
    // would leave the process held open by a socket nobody is reading.
    await waitFor(() => streams.size === 0, 'the stream to close');
    announce('rev-too-late');
    await settle(100);

    expect(seen).toEqual([]);
    expect(opens.length).toBe(atStop);
    expect(() => sub.stop()).not.toThrow();
  });

  it('keeps going when the caller’s refresh throws', async () => {
    const seen: string[] = [];
    const sub = subscribeCatalogEvents({
      config: config(),
      onRevision: (revision) => {
        seen.push(revision);
        if (revision === 'rev-2') throw new Error('the re-registration failed');
      },
    });
    try {
      await waitFor(() => streams.size > 0, 'the stream to open');
      announce('rev-2');
      announce('rev-3');

      // The caller owns its own failure reporting and its own retry (the
      // change stays owed there); dropping the subscription for it would make
      // one failed refresh cost the connection every LATER change too.
      await waitFor(() => seen.length === 2, 'the revision after the failure');
      expect(seen).toEqual(['rev-2', 'rev-3']);
    } finally {
      sub.stop();
    }
  });
});
