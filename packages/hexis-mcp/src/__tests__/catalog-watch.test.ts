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
   * Startup could not read a baseline (a blip on the revision read). Nobody
   * can then say whether a commit landed between discovery and the first poll,
   * and the two possible mistakes are not equal: adopting the first reading as
   * a baseline hides that commit's tool until someone restarts the server,
   * while refreshing costs one re-registration of a catalog that may well be
   * unchanged. So the first successful poll counts as a change — once.
   */
  it('refreshes once when startup could not read a baseline', async () => {
    vi.useFakeTimers();
    fetchCatalogRevision.mockResolvedValue('rev-1');
    const onChanged = vi.fn();

    const watch = watchCatalog({ config, initialRevision: null, intervalMs: 1_000, onChanged });
    try {
      await poll(1);
      expect(onChanged).toHaveBeenCalledExactlyOnceWith('rev-1');

      // …and that first poll IS the baseline from then on: an unchanged
      // catalog is not re-reported on every later poll.
      await poll(3);
      expect(onChanged).toHaveBeenCalledTimes(1);

      fetchCatalogRevision.mockResolvedValue('rev-2');
      await poll(1);
      expect(onChanged).toHaveBeenCalledTimes(2);
      expect(onChanged).toHaveBeenLastCalledWith('rev-2');
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
   * A refresh that fails must not wedge the watch — and must not be written
   * off either. Re-registration fails for the reasons every other request here
   * fails (a deployment mid-restart, a network that dropped), so the change is
   * still OWED: the watch keeps attempting it until one succeeds, rather than
   * leaving the toolset stale until some later commit happens to move the
   * catalog again. Once per failure streak in the log, like an outage.
   */
  it('retries a refresh that failed, and says so once', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    fetchCatalogRevision.mockResolvedValueOnce('rev-1').mockResolvedValue('rev-2');
    const onChanged = vi
      .fn()
      .mockRejectedValueOnce(new Error('re-registration failed'))
      .mockRejectedValueOnce(new Error('re-registration failed'))
      .mockResolvedValue(undefined);

    const watch = watchCatalog({ config, initialRevision: 'rev-1', intervalMs: 1_000, onChanged, log });
    try {
      await poll(4); // one unchanged poll, then two failures and the success
      expect(onChanged).toHaveBeenCalledTimes(3);
      expect(onChanged).toHaveBeenLastCalledWith('rev-2');
      expect(log.mock.calls.filter(([m]) => String(m).includes('refreshing the toolset'))).toHaveLength(1);

      // Applied at last, and not replayed on the polls that follow.
      await poll(3);
      expect(onChanged).toHaveBeenCalledTimes(3);
    } finally {
      watch.stop();
    }
  });

  /**
   * The budget is five seconds from commit to visible and the interval already
   * spends three, so the request's own latency cannot be spent on top of it:
   * the next poll is due one interval after this one STARTED, not after it
   * finished. A deployment answering in 800ms otherwise turns a 3s cadence
   * into 3.8s, and a refresh that drains a call turns it into 15s more.
   */
  it('holds its cadence when the deployment answers slowly', async () => {
    vi.useFakeTimers();
    fetchCatalogRevision.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 800); // the round trip, without the timers moving
      return 'rev-1';
    });

    const watch = watchCatalog({ config, initialRevision: 'rev-1', intervalMs: 1_000, onChanged: vi.fn() });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);

      // 200ms, not 1000: the 800 the answer took counts against the interval.
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchCatalogRevision).toHaveBeenCalledTimes(2);
    } finally {
      watch.stop();
    }
  });

  /** Untrusted text — a deployment's error string — can never forge a log line. */
  it('escapes what a deployment put in an error message', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    fetchCatalogRevision.mockRejectedValue(new DeploymentError('boom\n[hexis-mcp] forged', undefined));

    const watch = watchCatalog({ config, initialRevision: 'rev-1', intervalMs: 1_000, onChanged: vi.fn(), log });
    try {
      await poll(1);
      const line = String(log.mock.calls[0][0]);
      expect(line).toContain('boom\\n[hexis-mcp] forged');
      expect(line.split('\n')).toHaveLength(1);
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
