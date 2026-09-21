import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '../../modules/skills/skills.contract.js';
import { catalogRevision } from '../catalog-revision.js';
import { createCatalogChangeSignal, createCatalogEventsRoutes } from '../catalog-events.js';

/**
 * The stream that tells a long-lived client its released catalog moved,
 * without that client asking.
 *
 * `/agent/catalog-revision` answers the same question, and the bridge on
 * someone's laptop polls it — but only when that connection does something.
 * An idle one does nothing, so a `.tool` committed while its user was at lunch
 * stayed invisible there until they came back. A timer on the bridge would fix
 * that and was taken out twice, because two seconds per idle laptop is a load
 * that scales with laptops. This route is the other way round: the deployment
 * speaks when there is something to say, and says nothing the rest of the time.
 *
 * What it must get right: announce a real change promptly, announce NOTHING
 * otherwise (the signal behind it fires on every default-branch write, note
 * included, and an announcement re-registers an MCP session on every connected
 * laptop), and let go of a client that hangs up.
 */

const manualLine = (name: string, source = 'src-1'): string =>
  [name, name, `Plugins/Everyone/${name}.tool`, 'http', 'remote', 'Web search.', source].join('\u0000');

const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  name: 'rfi',
  description: 'Answers RFIs.',
  path: 'Skills/Ops/rfi',
  ...over,
});

let http: Server | null = null;

afterEach(async () => {
  if (http) {
    http.closeAllConnections?.();
    await new Promise<void>((resolve) => http!.close(() => resolve()));
    http = null;
  }
  vi.restoreAllMocks();
});

/** The catalog the route reads, mutable between reads exactly as a commit makes it. */
interface Catalog {
  manuals: string[];
  skills: SkillSummary[];
}

async function mount(deps: {
  catalog: Catalog;
  userId?: string | undefined;
  resolveUserEmail?: (userId: string) => Promise<string | undefined>;
  heartbeatMs?: number;
}): Promise<{
  url: string;
  signal: ReturnType<typeof createCatalogChangeSignal>;
  catalogFingerprints: ReturnType<typeof vi.fn>;
  listSkills: ReturnType<typeof vi.fn>;
}> {
  const signal = createCatalogChangeSignal();
  const catalogFingerprints = vi.fn(async () => [...deps.catalog.manuals]);
  const listSkills = vi.fn(async () => [...deps.catalog.skills]);
  const app = express();
  app.use(
    createCatalogEventsRoutes({
      toolManuals: { catalogFingerprints } as never,
      skills: { listSkills } as never,
      manualAuth: (req, _res, next) => {
        if (deps.userId !== undefined) req.toolAuth = { userId: deps.userId } as never;
        next();
      },
      resolveUserEmail: deps.resolveUserEmail ?? (async () => 'someone@example.com'),
      changes: signal,
      ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
    }),
  );
  http = app.listen(0);
  await new Promise<void>((resolve) => http!.once('listening', resolve));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, signal, catalogFingerprints, listSkills };
}

/**
 * An open stream, read the way the bridge reads it: every complete frame, as
 * it arrives.
 */
async function open(url: string): Promise<{
  frames: string[];
  revisions: string[];
  waitFor: (count: number, what: string) => Promise<void>;
  close: () => void;
  response: Response;
}> {
  const abort = new AbortController();
  const response = await fetch(`${url}/agent/catalog-events`, { signal: abort.signal });
  const frames: string[] = [];
  const revisions: string[] = [];
  void (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf('\n\n');
        while (at !== -1) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          frames.push(frame);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (data) revisions.push((JSON.parse(data) as { revision: string }).revision);
          at = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // The abort below is how this loop ends; nothing to report.
    }
  })();
  const waitFor = async (count: number, what: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (frames.length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { frames, revisions, waitFor, close: () => abort.abort(), response };
}

describe('GET /agent/catalog-events', () => {
  it('opens with the caller’s current fingerprint, ACL-filtered like the listings', async () => {
    const catalog: Catalog = { manuals: [manualLine('serper')], skills: [skill()] };
    const { url, catalogFingerprints, listSkills } = await mount({ catalog, userId: 'u1' });

    const stream = await open(url);
    try {
      await stream.waitFor(1, 'the opening revision');

      expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
      // The OPENING one matters on its own: it is what closes the gap between
      // a bridge's startup discovery and its subscription, so a commit that
      // landed inside that gap is picked up here rather than waiting for the
      // next commit to move the catalog again.
      expect(stream.revisions).toEqual([catalogRevision([manualLine('serper')], [skill()])]);
      // Per-caller, and read through the services themselves — this route adds
      // no second read model that could show a tool the listing hides.
      expect(catalogFingerprints).toHaveBeenCalledWith('someone@example.com');
      expect(listSkills).toHaveBeenCalledWith('someone@example.com');
    } finally {
      stream.close();
    }
  });

  it('announces a change the moment the signal fires', async () => {
    const catalog: Catalog = { manuals: [manualLine('serper')], skills: [] };
    const { url, signal } = await mount({ catalog, userId: 'u1' });

    const stream = await open(url);
    try {
      await stream.waitFor(1, 'the opening revision');

      catalog.manuals = [manualLine('serper'), manualLine('weather')];
      signal.notify();
      await stream.waitFor(2, 'the announcement');

      expect(stream.revisions[1]).toBe(catalogRevision(catalog.manuals, []));
      expect(stream.frames[1]).toContain('event: revision');
    } finally {
      stream.close();
    }
  });

  it('says nothing when the catalog did not actually move', async () => {
    const catalog: Catalog = { manuals: [manualLine('serper')], skills: [] };
    const { url, signal } = await mount({ catalog, userId: 'u1' });

    const stream = await open(url);
    try {
      await stream.waitFor(1, 'the opening revision');

      // The signal fires on ANY default-branch write — it carries no paths, by
      // design — so an ordinary note saved in the knowledge base arrives here
      // too. Announcing it would re-register the whole toolset on every
      // connected laptop for a commit that touched no manual and no skill.
      signal.notify();
      signal.notify();
      signal.notify();
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(stream.frames).toHaveLength(1);
    } finally {
      stream.close();
    }
  });

  it('collapses a burst of signals onto one re-read', async () => {
    const catalog: Catalog = { manuals: [manualLine('serper')], skills: [] };
    const { url, signal, catalogFingerprints } = await mount({ catalog, userId: 'u1' });

    const stream = await open(url);
    try {
      await stream.waitFor(1, 'the opening revision');
      const atOpen = catalogFingerprints.mock.calls.length;

      // One landing change is several signals: a merge emits one per workspace
      // it rewrote, a bulk write one per batch. A per-caller ACL walk each is
      // exactly the cost this route exists to avoid.
      catalog.manuals = [manualLine('serper'), manualLine('weather')];
      for (let i = 0; i < 8; i += 1) signal.notify();
      await stream.waitFor(2, 'the announcement');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(stream.frames).toHaveLength(2);
      expect(catalogFingerprints.mock.calls.length - atOpen).toBeLessThanOrEqual(2);
    } finally {
      stream.close();
    }
  });

  it('answers an unresolvable caller the empty catalog, as both listings do', async () => {
    const catalog: Catalog = { manuals: [manualLine('serper')], skills: [skill()] };
    const { url, catalogFingerprints } = await mount({ catalog, userId: undefined });

    const stream = await open(url);
    try {
      await stream.waitFor(1, 'the opening revision');

      expect(stream.revisions).toEqual([catalogRevision([], [])]);
      expect(catalogFingerprints).not.toHaveBeenCalled();
    } finally {
      stream.close();
    }
  });

  it('keeps the stream alive with a comment, which carries no revision', async () => {
    const catalog: Catalog = { manuals: [manualLine('serper')], skills: [] };
    const { url } = await mount({ catalog, userId: 'u1', heartbeatMs: 30 });

    const stream = await open(url);
    try {
      // Without this, everything between here and the client — Traefik,
      // nginx, Cloudflare — is free to call the connection idle and drop it.
      await stream.waitFor(3, 'a keep-alive');

      expect(stream.frames.slice(1).some((frame) => frame.startsWith(':'))).toBe(true);
      // And a keep-alive is not a change: a bridge that read one as a new
      // revision would re-register its toolset every twenty-five seconds.
      expect(stream.revisions).toHaveLength(1);
    } finally {
      stream.close();
    }
  });

  it('stops reading the catalog once the client hangs up', async () => {
    const catalog: Catalog = { manuals: [manualLine('serper')], skills: [] };
    const { url, signal, catalogFingerprints } = await mount({ catalog, userId: 'u1' });

    const stream = await open(url);
    await stream.waitFor(1, 'the opening revision');
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const atClose = catalogFingerprints.mock.calls.length;

    // A subscription left behind would do a per-caller ACL walk on every
    // default-branch write, forever, for a laptop that went home.
    catalog.manuals = [manualLine('serper'), manualLine('weather')];
    signal.notify();
    signal.notify();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(catalogFingerprints.mock.calls.length).toBe(atClose);
  });

  it('survives a catalog read that fails, and announces the next change', async () => {
    const catalog: Catalog = { manuals: [manualLine('serper')], skills: [] };
    const { url, signal } = await mount({
      catalog,
      userId: 'u1',
      resolveUserEmail: async () => 'someone@example.com',
    });

    const stream = await open(url);
    try {
      await stream.waitFor(1, 'the opening revision');

      // A read can fail for the reasons every read fails — a scan racing a
      // checkout, a disk blip. Dropping the subscription for it would leave
      // that bridge silent until it reconnected.
      catalog.skills = [
        {
          get name(): string {
            throw new Error('the working tree moved mid-scan');
          },
        } as never,
      ];
      signal.notify();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stream.frames).toHaveLength(1);

      catalog.skills = [skill()];
      signal.notify();
      await stream.waitFor(2, 'the announcement after the failed read');
      expect(stream.revisions[1]).toBe(catalogRevision(catalog.manuals, [skill()]));
    } finally {
      stream.close();
    }
  });
});

describe('createCatalogChangeSignal', () => {
  it('tells every subscriber, and stops at unsubscribe', () => {
    const signal = createCatalogChangeSignal();
    const a = vi.fn();
    const b = vi.fn();
    const offA = signal.subscribe(a);
    signal.subscribe(b);

    signal.notify();
    offA();
    signal.notify();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('carries on when one subscriber throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const signal = createCatalogChangeSignal();
    const after = vi.fn();
    signal.subscribe(() => {
      throw new Error('this stream is already closing');
    });
    signal.subscribe(after);

    // One laptop's stream must not cost every other subscriber — or the write
    // that emitted the event — its notification.
    expect(() => signal.notify()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('survives a subscriber that unsubscribes itself mid-notify', () => {
    const signal = createCatalogChangeSignal();
    const after = vi.fn();
    const off = signal.subscribe(() => off());
    signal.subscribe(after);

    expect(() => signal.notify()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
