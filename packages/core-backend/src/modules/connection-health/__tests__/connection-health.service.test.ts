import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionHealthService } from '../connection-health.service.js';
import type { IToolManualService, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
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

/** Records what the service persisted, without a database. */
function fakeDb() {
  const writes: { status: string; error: string | null }[] = [];
  const db = {
    insert: () => ({
      values: (v: { status: string; error: string | null }) => ({
        onConflictDoUpdate: async () => {
          writes.push({ status: v.status, error: v.error });
        },
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
  healthCheck: { url: 'https://api.acme.test/me', headers: { Authorization: 'Bearer ${API_KEY}' } },
};

function build(manual: ToolManualSummary, resolve: (key: string) => Promise<string | null>) {
  const { db, writes } = fakeDb();
  const toolManualService = {
    listAccessible: async () => [manual],
    toManualCallTemplates: async () => [],
  } as unknown as IToolManualService;
  const secretsVault = { resolve: (_u: string, key: string) => resolve(key) } as unknown as ISecretsVaultService;
  return { svc: new ConnectionHealthService(db, toolManualService, secretsVault), writes };
}

const withKey = (manual: ToolManualSummary = HTTP_TOOL) => build(manual, async () => 'sk-live-abc');

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
    const { svc } = withKey({ ...HTTP_TOOL, healthCheck: undefined });

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
    const { svc } = build(
      { ...HTTP_TOOL, healthCheck: { url: 'https://${HOST}/me' } },
      async () => '169.254.169.254',
    );

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    expect(r.status).toBe('unverifiable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws only when the manual itself cannot be read', async () => {
    const { svc } = withKey();
    await expect(svc.probe('u1', 'a@b.c', 'nope')).rejects.toThrow(/No readable tool manual/);
  });
});
