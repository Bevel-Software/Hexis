import { describe, expect, it, vi, afterEach } from 'vitest';
import type { HexisMcpConfig } from '../config.js';
import {
  RENEWAL_FRACTION,
  RETRY_AFTER_FAILURE_MS,
  cancelProactiveRenewal,
  renewConnectionKeyNow,
  scheduleProactiveRenewal,
} from '../renewal.js';

/**
 * The one renewal mechanism, tested as the unit it is: single-flight sharing,
 * proactive scheduling at ~80% of the granted lifetime, the credential
 * listener firing on every success, and the retry after a failed proactive
 * attempt. The wire-level integration (racing 401s through getJson against a
 * real stub deployment) lives in oauth.test.ts.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeConfig(
  renew: HexisMcpConfig['renewConnectionKey'],
): HexisMcpConfig {
  return { baseUrl: 'https://x.example', connectionKey: 'initial', renewConnectionKey: renew };
}

describe('renewConnectionKeyNow: single flight', () => {
  it('shares ONE in-flight renewal between concurrent callers', async () => {
    let resolveGrant!: (v: { token: string }) => void;
    const renew = vi.fn(
      () => new Promise<{ token: string }>((resolve) => (resolveGrant = resolve)),
    );
    const config = makeConfig(renew);

    const first = renewConnectionKeyNow(config);
    const second = renewConnectionKeyNow(config);
    resolveGrant({ token: 'fresh' });

    expect(await first).toBe('fresh');
    expect(await second).toBe('fresh');
    expect(renew).toHaveBeenCalledTimes(1);
    expect(config.connectionKey).toBe('fresh');
  });

  it('shares the failure too, and lets the NEXT call start a fresh flight', async () => {
    const renew = vi
      .fn<() => Promise<{ token: string }>>()
      .mockRejectedValueOnce(new Error('refresh died'))
      .mockResolvedValueOnce({ token: 'second-try' });
    const config = makeConfig(renew);

    const first = renewConnectionKeyNow(config);
    const second = renewConnectionKeyNow(config);
    await expect(first).rejects.toThrow('refresh died');
    await expect(second).rejects.toThrow('refresh died');
    expect(renew).toHaveBeenCalledTimes(1);

    // The flight is over; a later caller runs a new one.
    expect(await renewConnectionKeyNow(config)).toBe('second-try');
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('notifies the credential listener on every success — and its failure does not fail the renewal', async () => {
    const applied: string[] = [];
    const config = makeConfig(async () => ({ token: 'fresh' }));
    config.onConnectionKeyRenewed = async (token) => {
      applied.push(token);
      throw new Error('swap failed');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await renewConnectionKeyNow(config)).toBe('fresh');
    expect(applied).toEqual(['fresh']);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('swap failed'));
  });

  it('refuses key mode — there is nothing to renew', async () => {
    const config: HexisMcpConfig = { baseUrl: 'https://x.example', connectionKey: 'bevel_key' };
    await expect(renewConnectionKeyNow(config)).rejects.toThrow(/key mode/);
  });
});

describe('scheduleProactiveRenewal: the timer the remote manual depends on', () => {
  it('renews at ~80% of the granted lifetime and re-arms from each new grant', async () => {
    vi.useFakeTimers();
    const applied: string[] = [];
    let minted = 0;
    const config = makeConfig(async () => ({ token: `t${(minted += 1)}`, expiresInMs: 10_000 }));
    config.onConnectionKeyRenewed = (token) => {
      applied.push(token);
    };

    scheduleProactiveRenewal(config, 10_000);
    await vi.advanceTimersByTimeAsync(10_000 * RENEWAL_FRACTION);
    expect(applied).toEqual(['t1']);
    expect(config.connectionKey).toBe('t1');

    // The success re-armed from ITS grant: another 80% later, another renewal.
    await vi.advanceTimersByTimeAsync(10_000 * RENEWAL_FRACTION);
    expect(applied).toEqual(['t1', 't2']);
  });

  it('arms nothing without a lifetime, in key mode, or after cancel', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => ({ token: 'fresh' }));
    const config = makeConfig(renew);

    scheduleProactiveRenewal(config, undefined);
    scheduleProactiveRenewal(config, Number.NaN);
    scheduleProactiveRenewal(config, -5);
    const keyMode: HexisMcpConfig = { baseUrl: 'https://x.example', connectionKey: 'bevel_key' };
    scheduleProactiveRenewal(keyMode, 10_000);

    scheduleProactiveRenewal(config, 10_000);
    cancelProactiveRenewal(config);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(renew).not.toHaveBeenCalled();
  });

  it('retries after a failed proactive renewal instead of leaving the transport to die quietly', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const renew = vi
      .fn<() => Promise<{ token: string; expiresInMs?: number }>>()
      .mockRejectedValueOnce(new Error('deployment briefly down'))
      .mockResolvedValueOnce({ token: 'recovered', expiresInMs: 10_000 });
    const config = makeConfig(renew);

    scheduleProactiveRenewal(config, 10_000);
    await vi.advanceTimersByTimeAsync(10_000 * RENEWAL_FRACTION);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('proactive credential renewal failed'));

    await vi.advanceTimersByTimeAsync(RETRY_AFTER_FAILURE_MS);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(config.connectionKey).toBe('recovered');
  });
});
