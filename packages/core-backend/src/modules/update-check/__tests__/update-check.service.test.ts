import { describe, expect, it, vi } from 'vitest';
import {
  UpdateCheckService,
  isNewerVersion,
  parseReleaseVersion,
} from '../update-check.service.js';

/**
 * The update check's contract: lazy, cached, and SILENT on failure. The one
 * thing it must never do is turn an offline deployment (or a GitHub hiccup,
 * or a weird tag) into an error a user sees — every degraded path resolves to
 * `updateAvailable: false`.
 */

/** A fetch stub answering like the GitHub releases endpoint. */
function githubFetch(tag: string, notesUrl = 'https://github.com/Bevel-Software/Hexis/releases/tag/' + tag) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ tag_name: tag, html_url: notesUrl }),
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function service(opts: {
  enabled?: boolean;
  current?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}) {
  return new UpdateCheckService({
    enabled: opts.enabled ?? true,
    currentVersion: opts.current ?? '0.9.1',
    fetchFn: opts.fetchFn,
    now: opts.now,
  });
}

describe('version comparison', () => {
  it('compares numerically per part, not as strings', () => {
    expect(isNewerVersion('0.10.0', '0.9.1')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.9.2', '0.9.1')).toBe(true);
  });

  it('equal or older is not newer', () => {
    expect(isNewerVersion('0.9.1', '0.9.1')).toBe(false);
    expect(isNewerVersion('0.9.0', '0.9.1')).toBe(false);
    expect(isNewerVersion('0.8.9', '0.9.1')).toBe(false);
  });

  it('tolerates a leading v and refuses prerelease/malformed tags', () => {
    expect(parseReleaseVersion('v0.10.0')).toEqual([0, 10, 0]);
    expect(parseReleaseVersion('0.10.0-rc.1')).toBeNull();
    expect(parseReleaseVersion('nightly')).toBeNull();
    expect(parseReleaseVersion('')).toBeNull();
    expect(isNewerVersion('0.10.0-rc.1', '0.9.1')).toBe(false);
  });

  it('an unparseable RUNNING version never announces an update', () => {
    // `resolveAppVersion` answers 'unknown' when the manifest is unreadable —
    // that must fail toward silence, not toward "everything is newer".
    expect(isNewerVersion('0.10.0', 'unknown')).toBe(false);
  });
});

describe('UpdateCheckService.check', () => {
  it('reports an update when the published release is newer', async () => {
    const fetchFn = githubFetch('v0.10.0');
    const result = await service({ fetchFn }).check();
    expect(result).toEqual({
      updateAvailable: true,
      current: '0.9.1',
      latest: '0.10.0',
      notesUrl: 'https://github.com/Bevel-Software/Hexis/releases/tag/v0.10.0',
    });
    // No credentials, ever — the request is the whole payload.
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(new Headers(init.headers).get('accept')).toBe('application/vnd.github+json');
  });

  it('reports no update when equal or when the deployment is ahead', async () => {
    expect(await service({ fetchFn: githubFetch('v0.9.1') }).check()).toMatchObject({
      updateAvailable: false,
      current: '0.9.1',
      latest: '0.9.1',
    });
    expect(
      await service({ fetchFn: githubFetch('v0.9.0'), current: '0.9.1' }).check(),
    ).toMatchObject({ updateAvailable: false });
  });

  it('resolves a prerelease or malformed tag to "no update" without throwing', async () => {
    const result = await service({ fetchFn: githubFetch('v0.10.0-rc.1') }).check();
    expect(result.updateAvailable).toBe(false);
    // A tag that didn't parse is not offered as "latest".
    expect(result.latest).toBeUndefined();
  });

  it('disabled: answers immediately and never touches the network', async () => {
    const fetchFn = githubFetch('v99.0.0');
    const result = await service({ enabled: false, fetchFn }).check();
    expect(result).toEqual({ updateAvailable: false, current: '0.9.1' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a failed fetch is silent, and cached so a dead network is not re-probed', async () => {
    let now = 0;
    const fetchFn = vi.fn().mockRejectedValue(new Error('ENOTFOUND api.github.com'));
    const svc = service({ fetchFn: fetchFn as unknown as typeof fetch, now: () => now });

    expect(await svc.check()).toEqual({ updateAvailable: false, current: '0.9.1' });
    // Within the failure TTL (~15min): served from cache.
    now = 14 * 60 * 1000;
    await svc.check();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Past it: retried.
    now = 16 * 60 * 1000;
    await svc.check();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a success is cached for hours across requests', async () => {
    let now = 0;
    const fetchFn = githubFetch('v0.10.0');
    const svc = service({ fetchFn, now: () => now });

    const first = await svc.check();
    now = 5 * 60 * 60 * 1000; // 5h — inside the 6h TTL
    const second = await svc.check();
    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now = 7 * 60 * 60 * 1000; // past the TTL — refreshed
    await svc.check();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('concurrent requests share one in-flight fetch', async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn().mockImplementation(async () => {
      await gate;
      return { ok: true, json: async () => ({ tag_name: 'v0.10.0', html_url: 'u' }) };
    });
    const svc = service({ fetchFn: fetchFn as unknown as typeof fetch });

    const [a, b] = [svc.check(), svc.check()];
    release(undefined);
    expect(await a).toEqual(await b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('treats a non-2xx answer like any other failure: silent false', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const result = await service({ fetchFn: fetchFn as unknown as typeof fetch }).check();
    expect(result).toEqual({ updateAvailable: false, current: '0.9.1' });
  });
});
