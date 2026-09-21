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

    // Asserted by BEHAVIOUR rather than by promise identity: what a second
    // caller is owed is one read and an answer that waits for it, not the
    // same object. (The two are now different objects — each caller waits for
    // everything learned, which includes an announcement queued behind the
    // read, and that tail is not the same promise for both.)
    const settled: string[] = [];
    const first = check.check().then(() => settled.push('first'));
    const second = check.check().then(() => settled.push('second'));
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toEqual([]); // neither answers while the read is open

    release('rev-1');
    await Promise.all([first, second]);
    expect(settled.sort()).toEqual(['first', 'second']);
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);
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

/**
 * The other road a revision arrives by: the deployment volunteered it, over
 * the stream `catalog-events.ts` holds open. Everything the check's own body
 * guarantees has to hold identically here — a change is owed once, a failure
 * leaves it owed, teardown stops it — because a change must not be handled
 * differently depending on which road brought it.
 */
describe('CatalogCheck.notice — a revision the deployment announced', () => {
  it('refreshes without asking the deployment anything', async () => {
    const onChanged = vi.fn();
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged });

    await check.notice('rev-2');

    expect(onChanged).toHaveBeenCalledExactlyOnceWith('rev-2');
    // The whole point: no digest read. A bridge that answered an announcement
    // by going and asking would have made the stream a poll with extra steps.
    expect(fetchCatalogRevision).not.toHaveBeenCalled();
  });

  it('ignores an announcement of the revision it already serves', async () => {
    const onChanged = vi.fn();
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged });

    // The invalidation behind a real announcement carries no paths, so every
    // ordinary note's commit announces too. Re-registering every connected
    // client's whole toolset for one is the cost this must not have.
    await check.notice('rev-1');
    await check.notice('rev-1');

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('keeps the change owed when the refresh fails, and settles it on the next one', async () => {
    const onChanged = vi
      .fn()
      .mockRejectedValueOnce(new Error('the deployment is restarting'))
      .mockResolvedValue(undefined);
    const log = vi.fn();
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged, log });

    await check.notice('rev-2');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(' ')).toContain('refreshing the toolset after a workspace change failed');

    // `applied` never advanced, so the SAME revision is still a change. A
    // bridge that had recorded it would serve the old toolset until some
    // later commit happened to move the catalog again.
    await check.notice('rev-2');
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenLastCalledWith('rev-2');
  });

  it('runs one refresh at a time, in the order the revisions arrived', async () => {
    const order: string[] = [];
    let release = (): void => {};
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onChanged = vi.fn(async (revision: string) => {
      order.push(`start ${revision}`);
      if (revision === 'rev-2') await first;
      order.push(`end ${revision}`);
    });
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged });

    const a = check.notice('rev-2');
    const b = check.notice('rev-3');
    release();
    await Promise.all([a, b]);

    // Two announcements landing together must not have their re-registrations
    // overlap: each one deregisters every manual this process holds before
    // putting them back, and two doing that at once is how a client ends up
    // with a name registered twice or not at all.
    expect(order).toEqual(['start rev-2', 'end rev-2', 'start rev-3', 'end rev-3']);
  });

  it('opens a throttle window, so the listing a notification provokes asks nothing', async () => {
    const t = clock();
    const onChanged = vi.fn();
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', onChanged, now: t.now });

    await check.notice('rev-2');
    // An announcement is at least as fresh as anything this process could go
    // and read, so the `tools/list` it provokes has nothing left to ask. Every
    // change, times every connected client, is the round trip this saves.
    await check.check();
    expect(fetchCatalogRevision).not.toHaveBeenCalled();

    t.advance(CATALOG_CHECK_MIN_INTERVAL_MS);
    fetchCatalogRevision.mockResolvedValue('rev-2');
    await check.check();
    expect(fetchCatalogRevision).toHaveBeenCalledTimes(1);
  });

  it('makes a throttled listing wait for the refresh already running', async () => {
    const t = clock();
    let release = (): void => {};
    const refreshing = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const onChanged = vi.fn(async () => {
      await refreshing;
      finished = true;
    });
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', onChanged, now: t.now });

    const announced = check.notice('rev-2');
    // A listing arriving while the announcement's refresh is still running is
    // inside the throttle window, so it asks nothing — but returning ahead of
    // the refresh would hand back the toolset that refresh is replacing.
    const listing = check.check();
    let listingDone = false;
    void listing.then(() => (listingDone = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listingDone).toBe(false);

    release();
    await Promise.all([announced, listing]);
    expect(finished).toBe(true);
  });

  /**
   * A digest read takes a round trip, and an announcement can land inside it.
   * What the deployment volunteered is at least as fresh as what a read that
   * started earlier is about to return, so the read loses.
   *
   * The damage if it does not: the older fingerprint is applied on top, a
   * second re-registration runs for nothing, and `applied` ends up pointing
   * at a revision the catalog has already moved past — so the next check
   * announces a change that was already made, and a refresh that failed
   * halfway would leave the connection without its tools and no record that
   * anything was owed.
   */
  it('drops a check reading that an announcement overtook', async () => {
    let release: (value: string) => void = () => {};
    fetchCatalogRevision.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    const onChanged = vi.fn();
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged });

    const reading = check.check(); // in flight, will answer 'rev-2'
    await check.notice('rev-3'); // the deployment says so first
    expect(onChanged).toHaveBeenCalledExactlyOnceWith('rev-3');

    release('rev-2');
    await reading;

    // No second refresh, and nothing regressed: an announcement of 'rev-3'
    // now is correctly nothing to do.
    expect(onChanged).toHaveBeenCalledTimes(1);
    await check.notice('rev-3');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  /**
   * The same race from the LISTING's side. A `tools/list` that joined a check
   * already running must not answer from the toolset an announcement queued
   * behind that check is in the middle of replacing.
   */
  it('makes a listing wait for an announcement queued behind the check it joined', async () => {
    let release: (value: string) => void = () => {};
    fetchCatalogRevision.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    let finishRefresh = (): void => {};
    const refreshing = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const onChanged = vi.fn(async () => {
      await refreshing;
    });
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged });

    const reading = check.check();
    const announced = check.notice('rev-3'); // queued behind the read
    const listing = check.check(); // joins; must wait for BOTH
    let listingDone = false;
    void listing.then(() => (listingDone = true));

    release('rev-2');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The read has settled, but the announcement's refresh has not.
    expect(listingDone).toBe(false);

    finishRefresh();
    await Promise.all([reading, announced, listing]);
    expect(listingDone).toBe(true);
  });

  it('does nothing once stopped', async () => {
    const onChanged = vi.fn();
    const check = createCatalogCheck({ config, initialRevision: 'rev-1', minIntervalMs: 0, onChanged });

    check.stop();
    await check.notice('rev-2');

    // Teardown is exactly when a late announcement lands: the stream is being
    // closed, and a refresh started here would re-register manuals on a server
    // that is already going down.
    expect(onChanged).not.toHaveBeenCalled();
  });
});
