import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HexisMcpConfig } from '../config.js';
import { CatalogRevisionUnsupportedError, DeploymentError } from '../deployment.js';
import {
  CATALOG_CHECK_MIN_INTERVAL_MS,
  createCatalogCheck,
} from '../catalog-watch.js';

/**
 * The checker that tells a long-lived local server its deployment's catalog
 * moved.
 *
 * It asks nothing on its own — the server decides WHEN to check (on activity,
 * never on a timer; see `server.ts`). What is asserted here is what a check
 * does once asked. Mostly restraint: it fires
 * on a real change and on nothing else — a spurious fire re-registers an MCP
 * session, closing whatever it held, on every connected laptop — it collapses
 * a burst onto one read, and it survives a deployment that is briefly
 * unreachable without either giving up or writing a line per call for the
 * duration of the outage.
 */

const { fetchCatalogRevision } = vi.hoisted(() => ({ fetchCatalogRevision: vi.fn() }));
vi.mock('../deployment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deployment.js')>()),
  fetchCatalogRevision,
}));

const config = { baseUrl: 'http://workspace.test', connectionKey: 'k' } satisfies HexisMcpConfig;

afterEach(() => {
  fetchCatalogRevision.mockReset();
});

/** A clock the tests move by hand, so the throttle is asserted exactly. */
function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}

describe('createCatalogCheck', () => {
  it('asks nothing until it is asked to', async () => {
    createCatalogCheck({ config, initialRevision: 'rev-1', onChanged: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCatalogRevision).not.toHaveBeenCalled();
  });

  it('reports a change, once, when the revision moves', async () => {
    const t = clock();
    fetchCatalogRevision.mockResolvedValueOnce('rev-1').mockResolvedValue('rev-2');
    const onChanged = vi.fn();
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged, now: t.now });

    await check.check();
    expect(onChanged).not.toHaveBeenCalled(); // unchanged: nothing is owed

    await check.check();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith('rev-2');

    // …and the same revision is not re-reported on every later check.
    await check.check();
    await check.check();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  /**
   * The throttle. A `call_tool_chain` fanning out into a dozen calls, or a
   * client re-listing right after the notification a refresh just sent, must
   * cost the deployment one read, not one per event.
   */
  it('collapses checks inside the interval onto the last one', async () => {
    const t = clock();
    fetchCatalogRevision.mockResolvedValue('rev-1');
    const check = createCatalogCheck({
      config,
      initialRevision: 'rev-1',
      minIntervalMs: 5_000,
      onChanged: vi.fn(),
      now: t.now,
    });

    await check.check();
    await check.check();
    await check.check();
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);

    t.advance(4_999);
    await check.check();
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);

    t.advance(1);
    await check.check();
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(2);
  });

  /**
   * A clock set BACK — a sleep, an NTP correction, a VM migration — must not
   * turn the throttle into a refusal that lasts as long as the adjustment: a
   * negative gap since the last check can only mean the clock moved, and reads
   * as an expired throttle.
   */
  it('treats a clock that went backward as an expired throttle', async () => {
    const t = clock();
    fetchCatalogRevision.mockResolvedValue('rev-1');
    const check = createCatalogCheck({
      config,
      initialRevision: 'rev-1',
      minIntervalMs: 5_000,
      onChanged: vi.fn(),
      now: t.now,
    });

    await check.check();
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);

    t.advance(-60_000);
    await check.check();
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(2);

    // …and the throttle counts from the new reading, not the old one.
    t.advance(1_000);
    await check.check();
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(2);
  });

  it('joins a check already in flight rather than starting a second', async () => {
    let release: (value: string) => void = () => {};
    fetchCatalogRevision.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged: vi.fn() });

    const first = check.check();
    const second = check.check();
    expect(second).toBe(first);
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);
    release('rev-1');
    await first;
  });

  /**
   * Startup could not read a baseline (a blip on the revision read). Nobody
   * can then say whether a commit landed between discovery and the first
   * check, and the two possible mistakes are not equal: adopting the first
   * reading as a baseline hides that commit's tool until someone restarts the
   * server, while refreshing costs one re-registration of a catalog that may
   * well be unchanged. So the first successful check counts as a change — once.
   */
  it('refreshes once when startup could not read a baseline', async () => {
    fetchCatalogRevision.mockResolvedValue('rev-1');
    const onChanged = vi.fn();
    const check = createCatalogCheck({ config, initialRevision: null, minIntervalMs: 0, onChanged });

    await check.check();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith('rev-1');

    // …and that first check IS the baseline from then on.
    await check.check();
    await check.check();
    expect(onChanged).toHaveBeenCalledTimes(1);

    fetchCatalogRevision.mockResolvedValue('rev-2');
    await check.check();
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenLastCalledWith('rev-2');
  });

  it('keeps checking through an unreachable deployment, and says so once', async () => {
    const log = vi.fn();
    fetchCatalogRevision
      .mockResolvedValueOnce('rev-1')
      .mockRejectedValueOnce(new DeploymentError('Could not reach the catalog revision', undefined))
      .mockRejectedValueOnce(new DeploymentError('Could not reach the catalog revision', undefined))
      .mockResolvedValue('rev-2');
    const onChanged = vi.fn();
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged, log });

    await check.check();
    await check.check();
    await check.check();
    // Two failures, ONE line — an outage spanning a hundred calls must not
    // fill the operator's log with a hundred copies of itself.
    expect(log.mock.calls.filter(([m]) => String(m).includes('could not check'))).toHaveLength(1);

    // It recovered on the next call, and the change it missed is reported now.
    await check.check();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith('rev-2');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('answering again'));
  });

  it('stops for good against a deployment that does not serve the route', async () => {
    const log = vi.fn();
    fetchCatalogRevision.mockRejectedValue(
      new CatalogRevisionUnsupportedError('This deployment does not report a catalog revision', 404),
    );
    const check = createCatalogCheck({ config, initialRevision: null, minIntervalMs: 0, onChanged: vi.fn(), log });

    for (let i = 0; i < 5; i += 1) await check.check();
    // Asked once, told the reader what it means, and never asked again.
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('does not report a catalog revision'));
  });

  /**
   * A refresh that fails must not wedge the checker — and must not be written
   * off either. Re-registration fails for the reasons every other request here
   * fails (a deployment mid-restart, a network that dropped), so the change is
   * still OWED: the checker keeps attempting it on later calls until one
   * succeeds, rather than leaving the toolset stale until some later commit
   * happens to move the catalog again. Once per failure streak in the log.
   */
  it('retries a refresh that failed, and says so once', async () => {
    const log = vi.fn();
    fetchCatalogRevision.mockResolvedValueOnce('rev-1').mockResolvedValue('rev-2');
    const onChanged = vi
      .fn()
      .mockRejectedValueOnce(new Error('re-registration failed'))
      .mockRejectedValueOnce(new Error('re-registration failed'))
      .mockResolvedValue(undefined);
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged, log });

    for (let i = 0; i < 4; i += 1) await check.check(); // one unchanged, two failures, the success
    expect(onChanged).toHaveBeenCalledTimes(3);
    expect(onChanged).toHaveBeenLastCalledWith('rev-2');
    expect(log.mock.calls.filter(([m]) => String(m).includes('refreshing the toolset'))).toHaveLength(1);

    // Applied at last, and not replayed on the checks that follow.
    await check.check();
    await check.check();
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  /** A caller awaiting a check must never be handed a rejection. */
  it('never rejects, whatever the deployment or the refresh does', async () => {
    fetchCatalogRevision.mockRejectedValue(new Error('boom'));
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged: vi.fn(), log: vi.fn() });
    await expect(check.check()).resolves.toBeUndefined();
  });

  /** Untrusted text — a deployment's error string — can never forge a log line. */
  it('escapes what a deployment put in an error message', async () => {
    const log = vi.fn();
    fetchCatalogRevision.mockRejectedValue(new DeploymentError('boom\n[hexis-mcp] forged', undefined));
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged: vi.fn(), log });

    await check.check();
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('boom\\n[hexis-mcp] forged');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('asks nothing more once stopped', async () => {
    fetchCatalogRevision.mockResolvedValue('rev-1');
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged: vi.fn() });
    await check.check();
    const asked = fetchCatalogRevision.mock.calls.length;

    check.stop();
    check.stop(); // idempotent
    await check.check();
    await check.check();
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(asked);
  });

  /**
   * A stop that lands while a check is in flight — teardown is exactly when it
   * does — must not run the refresh against a server that is closing.
   */
  it('does not refresh when stopped mid-check', async () => {
    let release: (value: string) => void = () => {};
    fetchCatalogRevision.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    const onChanged = vi.fn();
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged });

    const pending = check.check();
    check.stop();
    release('rev-2');
    await pending;
    expect(onChanged).not.toHaveBeenCalled();
  });

  /**
   * The window is a CADENCE, counted from when a check started — so a check
   * that took a while does not silently widen it.
   *
   * It matters because a refresh runs inside a check and costs seconds. If the
   * window were counted from the settle, a two-second throttle plus a
   * two-and-a-half-second re-registration would be a four-and-a-half-second
   * window, and a person calling tools right after a commit would wait on a
   * throttle nobody chose.
   */
  it('counts its window from the start of a check, not the end of a slow one', async () => {
    const t = clock();
    fetchCatalogRevision.mockResolvedValueOnce('rev-2').mockResolvedValue('rev-2');
    // A refresh that takes longer than the whole window.
    const onChanged = vi.fn(async () => {
      t.advance(2_500);
    });
    const check = createCatalogCheck({
      config,
      initialRevision: 'rev-1',
      minIntervalMs: 2_000,
      onChanged,
      now: t.now,
    });

    await check.check(); // starts at 0, refreshes, settles at 2_500
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);

    // 2_500 on the clock: two seconds have passed SINCE THE CHECK STARTED, so
    // the next one is due. Counted from the settle this would be refused until
    // 4_500 — and the tick that was refused is the one a person is waiting on.
    await check.check();
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(2);
  });

  /**
   * THE BUDGET FOR A CONNECTION IN USE, as arithmetic rather than as a hope.
   *
   * A person who commits a manual and keeps calling tools on the same
   * connection should see it within about five seconds. The THROTTLE is the
   * ceiling on staleness there — a check landing immediately before the commit
   * reads the old catalog and opens a fresh window, so nothing can be noticed
   * until it expires — then one digest read and the re-registration a change
   * costs, which measured ~2.4s against a hosted deployment. At five seconds
   * the throttle ALONE put the first sighting at ~7.6s. Two leaves the rest of
   * the budget for the work. (An idle connection is outside this budget by
   * design: it asks nothing until its next use.)
   */
  it('leaves room inside the five seconds a connection in use is promised', () => {
    expect(CATALOG_CHECK_MIN_INTERVAL_MS).toBeGreaterThan(0);
    // ~2.4s of re-registration, measured, plus a digest read.
    const refreshCost = 2_600;
    expect(CATALOG_CHECK_MIN_INTERVAL_MS + refreshCost).toBeLessThanOrEqual(5_000);
  });
});
