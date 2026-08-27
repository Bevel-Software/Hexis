import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionHealthService } from '../connection-health.service.js';
import type {
  IToolManualService,
  ToolHealthCheck,
  ToolManualSummary,
} from '../../tool-manuals/tool-manuals.contract.js';
import type { ISecretsVaultService } from '../../secrets-vault/secrets-vault.contract.js';
import type { Database } from '../../database/connection.js';

/**
 * The three-way verdict is the whole point of this module, and the line that
 * matters most is between `failed` and `unverifiable`.
 *
 * `failed` is the only status that ACCUSES the user's credential, so it must be
 * reachable ONLY from a provider definitively rejecting it. Everything else —
 * a timeout, a 500, a tool with nothing to call — has to come back "we don't
 * know", because a badge that shouts "not working" during someone else's outage
 * gets ignored, and an ignored badge is the bug we started with wearing a
 * different colour.
 */

/**
 * A database stand-in that ENFORCES the write guard, because the guard is the
 * thing most worth testing.
 *
 * `probe()` writes with `setWhere: lt(probeStartedAt, <this probe's start>)`,
 * so a probe that began before whatever currently owns the row is refused and
 * reports zero rows. A stub that always accepted the write would make that
 * branch — and the re-read that follows it — unreachable, so a regression
 * letting a stale probe overwrite a newer verdict would pass silently.
 *
 * `stored` seeds the row a probe is racing against.
 */
function fakeDb(stored?: { status: string; error: string | null; probeStartedAt: Date }) {
  const writes: { status: string; error: string | null }[] = [];
  let row = stored ?? null;
  const db = {
    insert: () => ({
      values: (v: { status: string; error: string | null; probeStartedAt: Date }) => ({
        // `setWhere` is what separates the two writers: a PROBE passes the
        // guard and may be refused; an INVALIDATION passes none and always
        // lands (that is the whole point of it upserting).
        onConflictDoUpdate: (cfg: { setWhere?: unknown }) => {
          let applied: boolean | null = null;
          const apply = (): boolean => {
            if (applied !== null) return applied;
            const guarded = cfg?.setWhere !== undefined;
            if (guarded && row && !(row.probeStartedAt < v.probeStartedAt)) {
              applied = false;
              return applied;
            }
            row = { status: v.status, error: v.error, probeStartedAt: v.probeStartedAt };
            writes.push({ status: v.status, error: v.error });
            applied = true;
            return applied;
          };
          return {
            returning: async () => (apply() ? [{ id: 'row' }] : []),
            // Awaited directly, with no `returning()` — the invalidation path.
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve().then(apply).then(res, rej),
          };
        },
      }),
    }),
    // What `probe()` re-reads when the guard refuses its write.
    select: () => ({
      from: () => ({
        where: async () =>
          row
            ? [{ manualName: 'acme', status: row.status, error: row.error, checkedAt: new Date() }]
            : [],
      }),
    }),
  } as unknown as Database;
  return { db, writes };
}

const HTTP_TOOL: ToolManualSummary = {
  slug: 'acme',
  name: 'acme',
  path: 'Plugins/acme.tool',
  type: 'http',
};

const DECLARED_PROBE: ToolHealthCheck = {
  url: 'https://api.acme.test/me',
  headers: { Authorization: 'Bearer ${API_KEY}' },
};

function build(
  manual: ToolManualSummary,
  resolve: (key: string) => Promise<string | null>,
  probe: ToolHealthCheck | null = DECLARED_PROBE,
  stored?: { status: string; error: string | null; probeStartedAt: Date },
) {
  const { db, writes } = fakeDb(stored);
  const toolManualService = {
    listAccessible: async () => [manual],
    toManualCallTemplates: async () => [],
    // Probe config travels by its own accessor rather than on the summary: it
    // carries `headers`, which a `.tool` may write as a literal token, and the
    // summary is serialized straight to the browser.
    healthCheckFor: async () => probe,
  } as unknown as IToolManualService;
  const secretsVault = { resolve: (_u: string, key: string) => resolve(key) } as unknown as ISecretsVaultService;
  return { svc: new ConnectionHealthService(db, toolManualService, secretsVault), writes };
}

const withKey = (manual: ToolManualSummary = HTTP_TOOL, probe: ToolHealthCheck | null = DECLARED_PROBE) =>
  build(manual, async () => 'sk-live-abc', probe);

describe('ConnectionHealthService: what the probe concludes', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is ok when the provider accepts the credential', async () => {
    const { svc, writes } = withKey();
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    expect(r.status).toBe('ok');
    expect(r.detail).toBeNull();
    expect(writes).toEqual([{ status: 'ok', error: null }]);
  });

  it('carries the credential into the probe, so it tests what the tool would send', async () => {
    const { svc } = withKey();
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    await svc.probe('u1', 'a@b.c', 'acme');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.acme.test/me');
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer sk-live-abc' });
    // A probe runs unattended on every save; it must not be able to mutate, and
    // a 3xx to an internal host must not be followed.
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).redirect).toBe('manual');
  });

  it.each([401, 403])('fails on a definitive rejection (%i), quoting the provider', async (status) => {
    const { svc, writes } = withKey();
    vi.mocked(fetch).mockResolvedValue(new Response('invalid api key', { status }));

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    expect(r.status).toBe('failed');
    expect(r.detail).toContain('invalid api key');
    expect(writes).toEqual([{ status: 'failed', error: r.detail }]);
  });

  it('does NOT accuse the credential when the provider is merely unwell', async () => {
    const { svc } = withKey();
    vi.mocked(fetch).mockResolvedValue(new Response('boom', { status: 500 }));

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    expect(r.status).toBe('unverifiable');
    expect(r.detail).toContain('500');
  });

  it('does NOT accuse the credential when the provider is unreachable', async () => {
    const { svc } = withKey();
    vi.mocked(fetch).mockRejectedValue(new Error('ETIMEDOUT'));

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    expect(r.status).toBe('unverifiable');
    expect(r.detail).toMatch(/Couldn't reach the provider/);
  });

  it('does not fire a request at all when the credential is not set yet', async () => {
    const { svc } = build(HTTP_TOOL, async () => null);

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    // Sending an empty Bearer and reading the inevitable 401 would report a
    // MISSING key as a WRONG one — two different problems with two different fixes.
    expect(r.status).toBe('unverifiable');
    expect(r.detail).toMatch(/isn't set yet/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is unverifiable, not ok, for an http tool that declares no probe', async () => {
    const { svc } = withKey(HTTP_TOOL, null);

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    expect(r.status).toBe('unverifiable');
    expect(r.detail).toMatch(/doesn't offer a way to test/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is unverifiable for a local-only tool this server cannot reach', async () => {
    const { svc } = withKey({ ...HTTP_TOOL, remote: false });

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    expect(r.status).toBe('unverifiable');
    expect(r.detail).toMatch(/local agent/);
    expect(fetch).not.toHaveBeenCalled();
  });

  /**
   * The parse-time SSRF guard cannot check a TEMPLATED host — it does not exist
   * until a secret resolves — so the fetch-time re-check is the only thing
   * standing between a `.tool` and the cloud metadata endpoint.
   */
  it('refuses to call an internal host a variable resolved to', async () => {
    const { svc } = build({ ...HTTP_TOOL }, async () => '169.254.169.254', {
      url: 'https://${HOST}/me',
    });

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    expect(r.status).toBe('unverifiable');
    expect(fetch).not.toHaveBeenCalled();
  });

  /**
   * The write guard. A verdict describes the credential as it was when the
   * probe STARTED, so anything newer must win regardless of finishing order —
   * otherwise a slow probe against a replaced key gets the last word, which is
   * the bug this whole feature exists to remove, one layer down.
   */
  describe('the write guard', () => {
    it('refuses a probe that began before the verdict now stored, and reports the stored one', async () => {
      const newer = new Date(Date.now() + 60_000);
      const { svc, writes } = build(
        HTTP_TOOL,
        async () => 'sk-live-abc',
        DECLARED_PROBE,
        // Something newer already speaks for this row — an invalidation from a
        // key the user just saved, or a probe that started after this one.
        { status: 'unverifiable', error: "This hasn't been tested since the credential changed.", probeStartedAt: newer },
      );
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      // The probe SUCCEEDED, and is still discarded: it describes the old key.
      expect(writes).toEqual([]);
      expect(r.status).toBe('unverifiable');
      expect(r.detail).toMatch(/since the credential changed/);
    });

    it('accepts a probe that began after the verdict now stored', async () => {
      const older = new Date(Date.now() - 60_000);
      const { svc, writes } = build(HTTP_TOOL, async () => 'sk-live-abc', DECLARED_PROBE, {
        status: 'failed',
        error: 'old rejection',
        probeStartedAt: older,
      });
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      expect(r.status).toBe('ok');
      expect(writes).toEqual([{ status: 'ok', error: null }]);
    });

    it('refuses an invalidation older than the verdict already stored', async () => {
      // The ordering rule has to bind BOTH writers. A probe deferring to an
      // invalidation while a delayed invalidation could still clobber a newer
      // probe's valid result would be a guard that only works one way.
      const newer = new Date(Date.now() + 60_000);
      const { svc, writes } = build(HTTP_TOOL, async () => 'sk-live-abc', DECLARED_PROBE, {
        status: 'ok',
        error: null,
        probeStartedAt: newer,
      });

      await svc.forget('u1', 'acme');

      expect(writes).toEqual([]);
    });

    /**
     * `forget` UPSERTS rather than UPDATEs for exactly this reason: with no row,
     * an UPDATE leaves invalidation no trace, the probe's INSERT finds no
     * conflict, and the guard is never consulted — so a stale verdict lands
     * with every mechanism above it intact and useless.
     */
    it('leaves a mark when invalidating a pair that has no row yet', async () => {
      const { svc, writes } = build(HTTP_TOOL, async () => 'sk-live-abc');
      await svc.forget('u1', 'acme');
      expect(writes).toEqual([
        { status: 'unverifiable', error: "This hasn't been tested since the credential changed." },
      ]);

      // And that mark is now what a probe started before it must lose to.
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));
      const r = await svc.probe('u1', 'a@b.c', 'acme');
      expect(r.status).toBe('ok'); // this probe started after, so it legitimately wins
    });
  });

  it('throws only when the manual itself cannot be read', async () => {
    const { svc } = withKey();
    await expect(svc.probe('u1', 'a@b.c', 'nope')).rejects.toThrow(/No readable tool manual/);
  });
});
