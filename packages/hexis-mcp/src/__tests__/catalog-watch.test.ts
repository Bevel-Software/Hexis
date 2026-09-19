import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HexisMcpConfig } from '../config.js';
import { CatalogRevisionUnsupportedError, DeploymentError } from '../deployment.js';
import { CATALOG_POLL_INTERVAL_MS, watchCatalog } from '../catalog-watch.js';

/**
 * The poller that tells a long-lived local server its deployment's catalog
 * moved.
 *
 * Everything asserted here is about restraint. It must fire on a real change
 * and on nothing else — a spurious fire re-registers an MCP session (closing
 * whatever it held) on every connected laptop — and it must survive a
 * deployment that is briefly unreachable without either giving up or writing a
 * line every three seconds for the duration of the outage.
 */

const { fetchCatalogRevision } = vi.hoisted(() => ({ fetchCatalogRevision: vi.fn() }));
vi.mock('../deployment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deployment.js')>()),
  fetchCatalogRevision,
}));

const config = { baseUrl: 'http://workspace.test', connectionKey: 'k' } satisfies HexisMcpConfig;

afterEach(() => {
  vi.useRealTimers();
  fetchCatalogRevision.mockReset();
});

/**
 * Run `polls` polls to completion. The watch schedules the next poll only
 * after the current one settles, so each round is "advance the clock, then let
 * the microtasks the tick queued run".
 */
async function poll(times = 1, intervalMs = 1_000): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(intervalMs);
  }
}

describe('watchCatalog', () => {
  it('reports a change, once, when the revision moves', async () => {
    vi.useFakeTimers();
    fetchCatalogRevision.mockResolvedValueOnce('rev-1').mockResolvedValue('rev-2');
    const onChanged = vi.fn();

    const watch = watchCatalog({ config, initialRevision: 'rev-1', intervalMs: 1_000, onChanged });
    try {
      await poll(1);
      expect(onChanged).not.toHaveBeenCalled(); // unchanged: nothing is owed

      await poll(1);
      expect(onChanged).toHaveBeenCalledExactlyOnceWith('rev-2');

      // …and the same revision is not re-reported on every later poll.
      await poll(3);
      expect(onChanged).toHaveBeenCalledTimes(1);
    } finally {
      watch.stop();
    }
  });

  /**
   * Startup could not read a baseline (an older deployment, a blip). The first
   * successful poll establishes one and reports NOTHING: the toolset that
   * discovery built is the catalog that poll just read, so a refresh would be
   * work nobody owed.
   */
  it('establishes a baseline from the first poll when startup had none', async () => {
    vi.useFakeTimers();
    fetchCatalogRevision.mockResolvedValue('rev-1');
    const onChanged = vi.fn();

    const watch = watchCatalog({ config, initialRevision: null, intervalMs: 1_000, onChanged });
    try {
      await poll(2);
      expect(onChanged).not.toHaveBeenCalled();

      fetchCatalogRevision.mockResolvedValue('rev-2');
      await poll(1);
      expect(onChanged).toHaveBeenCalledExactlyOnceWith('rev-2');
    } finally {
      watch.stop();
    }
  });

  it('keeps polling through an unreachable deployment, and says so once', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    fetchCatalogRevision
      .mockResolvedValueOnce('rev-1')
      .mockRejectedValueOnce(new DeploymentError('Could not reach the catalog revision', undefined))
      .mockRejectedValueOnce(new DeploymentError('Could not reach the catalog revision', undefined))
      .mockResolvedValue('rev-2');
    const onChanged = vi.fn();

    const watch = watchCatalog({ config, initialRevision: 'rev-1', intervalMs: 1_000, onChanged, log });
    try {
      await poll(3);
      // Two failures, ONE line — an outage that lasts an hour must not fill
      // the operator's log with 1200 copies of itself.
      expect(log.mock.calls.filter(([m]) => String(m).includes('could not check'))).toHaveLength(1);

      // It recovered on its own, and the change it missed is reported now.
      await poll(1);
      expect(onChanged).toHaveBeenCalledExactlyOnceWith('rev-2');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('answering again'));
    } finally {
      watch.stop();
    }
  });

  it('stops for good against a deployment that does not serve the route', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    fetchCatalogRevision.mockRejectedValue(
      new CatalogRevisionUnsupportedError('This deployment does not report a catalog revision', 404),
    );

    const watch = watchCatalog({ config, initialRevision: null, intervalMs: 1_000, onChanged: vi.fn(), log });
    try {
      await poll(5);
      // Asked once, told the reader what it means, and never asked again.
      expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('does not report a catalog revision'));
    } finally {
      watch.stop();
    }
  });

  /**
   * A refresh that fails must not wedge the watch, and must not be retried
   * against a catalog that has not moved since — the next REAL change is what
   * earns the next attempt.
   */
  it('survives a handler that throws, and does not replay the same change', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    fetchCatalogRevision.mockResolvedValueOnce('rev-1').mockResolvedValue('rev-2');
    const onChanged = vi.fn().mockRejectedValue(new Error('re-registration failed'));

    const watch = watchCatalog({ config, initialRevision: 'rev-1', intervalMs: 1_000, onChanged, log });
    try {
      await poll(4);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('re-registration failed'));

      fetchCatalogRevision.mockResolvedValue('rev-3');
      await poll(1);
      expect(onChanged).toHaveBeenCalledTimes(2);
    } finally {
      watch.stop();
    }
  });

  it('asks nothing more once stopped', async () => {
    vi.useFakeTimers();
    fetchCatalogRevision.mockResolvedValue('rev-1');
    const watch = watchCatalog({ config, initialRevision: 'rev-1', intervalMs: 1_000, onChanged: vi.fn() });
    await poll(1);
    const asked = fetchCatalogRevision.mock.calls.length;

    watch.stop();
    watch.stop(); // idempotent
    await poll(5);
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(asked);
  });

  it('never polls at all when the interval is zero', async () => {
    vi.useFakeTimers();
    watchCatalog({ config, intervalMs: 0, onChanged: vi.fn() }).stop();
    await poll(5);
    expect(fetchCatalogRevision).not.toHaveBeenCalled();
  });

  /**
   * The guide states five seconds from commit to visible. The poll is the only
   * delay in that budget that this package chooses — the rest is one HTTP
   * round trip — so it has to leave room for one.
   */
  it('polls well inside the five seconds the guide promises', () => {
    expect(CATALOG_POLL_INTERVAL_MS).toBeLessThan(5_000);
  });
});
