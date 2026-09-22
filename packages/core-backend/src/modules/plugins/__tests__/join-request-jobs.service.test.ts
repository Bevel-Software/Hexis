import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_BRANCH, joinBranchFor } from '@bevel-software/platform-shared';
import {
  PluginJoinRequestJobs,
  JoinRequestNotReadyError,
  type JoinRequestJobsDeps,
  CLAIM_STALE_AFTER_MS,
} from '../join-request-jobs.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { FakeJoinRequestStore } from './fake-join-request-store.js';

/**
 * The git half of a join request, on its own: what it does to the row it was
 * handed, and what it refuses to do twice.
 *
 * The route's own tests cover the pairing — one click, one row, one change
 * request. What is here is the part a route cannot reach: two flights racing,
 * a key nothing answers to any more, and the words a failure leaves behind.
 */

const ALI = 'ali@bevel.software';
const ALI_USER = { id: 'u-1', email: ALI, name: 'Ali Baba' };
const KB = 'knowledge-base';
const ACCESS_MD = '---\nread:\n  - everyone\n---\nread: []\n';

function harness(over: Partial<JoinRequestJobsDeps> = {}, sharedStore?: FakeJoinRequestStore) {
  const workflow = {
    listChangeRequestsAuthoredBy: vi.fn(async () => [] as never[]),
    createBranch: vi.fn(async () => ({ name: 'x', isDefault: false, isProtected: false })),
    listBranches: vi.fn(async () => [] as { name: string }[]),
    commitChanges: vi.fn(async () => null),
    openChangeRequest: vi.fn(async () => ({ number: 42 })),
  };
  const workspaceService = {
    getOrCreateForBranch: async (branch: string) => ({ id: workspaceIdForBranch(branch) }),
    readFile: vi.fn(async () => ACCESS_MD),
    writeFile: vi.fn(async () => undefined),
  };
  const store = sharedStore ?? new FakeJoinRequestStore();
  const jobs = new PluginJoinRequestJobs(store, {
    workflow: workflow as never,
    workspaceService: workspaceService as never,
    kbDirName: KB,
    target: async () => ({ folder: 'Plugins/Finance', displayName: 'Finance' }),
    requester: async (mail) => ({ ...ALI_USER, email: mail }),
    ...over,
  });
  return { workflow, workspaceService, store, jobs };
}

function pendingRow(store: FakeJoinRequestStore) {
  return store.seed({
    requesterEmail: ALI,
    requesterName: 'Ali Baba',
    pluginKey: 'Finance',
    status: 'pending',
    failureReason: null,
    changeRequestNumber: null,
    claimedAt: null,
  });
}

describe('PluginJoinRequestJobs', () => {
  // Silenced for the whole file and restored after EVERY test, including one
  // that fails an assertion partway: a `mockRestore()` on the success path
  // leaves console.error stubbed for every later test in the file the moment
  // anything above it throws, which hides exactly the output you need to see.
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
    // The same discipline, for the same reason. Several tests below install
    // fake timers and move the system clock minutes forward; a
    // `useRealTimers()` on the success path leaves both in place for every
    // later test in the file the moment an assertion above it fails, and a
    // shifted clock makes the claim-window tests fail in ways that have
    // nothing to do with what they are testing. Harmless when no test
    // installed them.
    vi.useRealTimers();
  });

  it('runs the same steps the endpoint used to run inline, and records the number', async () => {
    const h = harness();
    await h.jobs.start(pendingRow(h.store));

    const branch = joinBranchFor(ALI, 'Finance');
    expect(h.workflow.createBranch).toHaveBeenCalledWith(
      workspaceIdForBranch(DEFAULT_BRANCH),
      branch,
      DEFAULT_BRANCH,
    );
    const write = h.workspaceService.writeFile.mock.calls[0] as unknown as [string, string, string];
    expect(write[1]).toBe(`${KB}/Plugins/Finance/access.md`);
    expect(write[2]).toContain('Ali Baba <ali@bevel.software>');
    expect(h.workflow.commitChanges).toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).toHaveBeenCalledWith(
      workspaceIdForBranch(branch),
      expect.objectContaining({ email: ALI }),
      expect.objectContaining({ title: 'Join request: Finance', sourceBranch: branch }),
    );
    expect(h.store.all()).toMatchObject([{ status: 'opened', changeRequestNumber: 42 }]);
  });

  it('two starts on one record are one flight, and one change request', async () => {
    const h = harness();
    const record = pendingRow(h.store);
    await Promise.all([h.jobs.start(record), h.jobs.start(record)]);
    expect(h.workflow.openChangeRequest).toHaveBeenCalledTimes(1);
  });

  it('a start on a record another flight already opened does nothing at all', async () => {
    const h = harness();
    const record = pendingRow(h.store);
    await h.jobs.start(record);
    // The SAME stale snapshot a second tab would hold: still `pending` in
    // this object, `opened` in the store.
    await h.jobs.start(record);
    expect(h.workflow.openChangeRequest).toHaveBeenCalledTimes(1);
  });

  it('leaves the branch alone when the grant is already on it', async () => {
    const h = harness();
    h.workspaceService.readFile.mockResolvedValue(
      `---\nread:\n  - everyone\n---\nread:\n  - Ali Baba <ali@bevel.software>\n`,
    );
    await h.jobs.start(pendingRow(h.store));
    expect(h.workspaceService.writeFile).not.toHaveBeenCalled();
    expect(h.workflow.commitChanges).not.toHaveBeenCalled();
    // Still opens the request: the branch carries the proposal either way.
    expect(h.workflow.openChangeRequest).toHaveBeenCalledTimes(1);
  });

  it('records a failure in the words the git work used, with credentials stripped', async () => {
    const h = harness();
    h.workflow.openChangeRequest.mockRejectedValue(
      new Error("fatal: unable to access 'https://x-access-token:ghp_secret@github.com/acme/kb'"),
    );
    await h.jobs.start(pendingRow(h.store));

    const [row] = h.store.all();
    expect(row.status).toBe('failed');
    expect(row.failureReason).toContain('unable to access');
    expect(row.failureReason).not.toContain('ghp_secret');
  });

  it('fails the record rather than throwing when the plugin is gone', async () => {
    const h = harness({ target: async () => null });
    await expect(h.jobs.start(pendingRow(h.store))).resolves.toBeUndefined();
    expect(h.store.all()).toMatchObject([
      { status: 'failed', failureReason: 'the plugin is no longer available' },
    ]);
    expect(h.workflow.createBranch).not.toHaveBeenCalled();
  });

  it('fails the record when no account answers to the address that asked', async () => {
    const h = harness({ requester: async () => null });
    await h.jobs.start(pendingRow(h.store));
    expect(h.store.all()).toMatchObject([
      { status: 'failed', failureReason: 'the account that asked no longer exists' },
    ]);
  });

  it('opens nothing for an account erased and made again under the same address', async () => {
    let asked = 0;
    const h = harness({
      requester: async (mail) => ({ ...ALI_USER, id: asked++ === 0 ? 'u-1' : 'u-2', email: mail }),
    });
    await h.jobs.start(pendingRow(h.store));
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
    expect(h.store.all()).toMatchObject([{ status: 'failed' }]);
  });

  it('starts nothing once the sweep is stopped — the row waits for the next boot', async () => {
    const h = harness();
    h.jobs.stopSweeping();
    await h.jobs.start(pendingRow(h.store));
    expect(h.workflow.createBranch).not.toHaveBeenCalled();
    expect(h.store.all()).toMatchObject([{ status: 'pending' }]);
  });

  it('opens nothing for an account erased while the branch was being pushed', async () => {
    // The account answers when the job starts and is gone by the time the
    // change request would open — the erasure landed during the git work.
    let asked = 0;
    const h = harness({
      requester: async (mail) => (asked++ === 0 ? { ...ALI_USER, email: mail } : null),
    });
    await h.jobs.start(pendingRow(h.store));
    expect(h.workflow.commitChanges).toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
    expect(h.store.all()).toMatchObject([
      { status: 'failed', failureReason: 'the account that asked no longer exists' },
    ]);
  });

  it('sweeps only the pending rows, and leaves the settled ones alone', async () => {
    const h = harness();
    pendingRow(h.store);
    h.store.seed({
      requesterEmail: 'mia@bevel.software',
      requesterName: 'Mia',
      pluginKey: 'GTM',
      status: 'opened',
      failureReason: null,
      changeRequestNumber: 7,
      claimedAt: null,
    });
    h.store.seed({
      requesterEmail: 'mia@bevel.software',
      requesterName: 'Mia',
      pluginKey: 'Ops',
      status: 'failed',
      failureReason: 'the remote refused the push',
      changeRequestNumber: null,
      claimedAt: null,
    });

    await h.jobs.sweep();
    await h.jobs.drain();

    expect(h.workflow.openChangeRequest).toHaveBeenCalledTimes(1);
    expect(h.store.all().map((r) => r.status)).toEqual(['opened', 'opened', 'failed']);
  });

  it('the sweep returns without waiting for the git it started', async () => {
    const h = harness();
    // A first request from a person is a full clone; the boot must not queue
    // behind one, so `sweep` resolves once the work is under way.
    let release = () => {};
    h.workflow.createBranch.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ name: 'x', isDefault: false, isProtected: false });
      }) as never,
    );
    pendingRow(h.store);

    await h.jobs.sweep();
    expect(h.store.all()).toMatchObject([{ status: 'pending' }]);

    release();
    await h.jobs.drain();
    expect(h.store.all()).toMatchObject([{ status: 'opened' }]);
  });

  it('does not run a record another process holds — the redeploy overlap', async () => {
    const h = harness();
    const record = pendingRow(h.store);
    // What the OTHER server in a redeploy window leaves behind: the row is
    // still pending, and its claim is live (it is beating).
    await h.store.claim(record.id, CLAIM_STALE_AFTER_MS);

    await h.jobs.start({ ...record });

    // Not "opened twice" — not started at all. Two servers cloning and
    // pushing the same branch into one shared workspace is the thing the
    // claim exists to prevent, and neither one's single-flight map can see
    // the other.
    expect(h.workflow.createBranch).not.toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
    expect(h.store.all()[0].status).toBe('pending');
  });

  it('takes over a claim left by a process that died holding it', async () => {
    const h = harness();
    const record = pendingRow(h.store);
    await h.store.claim(record.id, CLAIM_STALE_AFTER_MS);
    // The dead process stopped beating; the window lapses. `setSystemTime`
    // rather than a `Date.now` spy, because the store stamps claims with
    // `new Date()` and a spy on `now` leaves that reading the real clock.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + CLAIM_STALE_AFTER_MS + 1000);

    await h.jobs.start({ ...record });

    expect(h.store.all()[0]).toMatchObject({ status: 'opened', changeRequestNumber: 42 });
  });

  it('a request claimed the instant before a crash is finished by the next boot', async () => {
    // THE AC5 REGRESSION, exactly as local testing reproduced it: the click is
    // answered, `run` claims the row, and the process is killed a moment
    // later. The row is left pending with a claim seconds old.
    const h = harness();
    const record = pendingRow(h.store);
    await h.store.claim(record.id, CLAIM_STALE_AFTER_MS);
    expect(h.store.all()[0]).toMatchObject({ status: 'pending', changeRequestNumber: null });

    // A boot takes a couple of minutes. The claim was sized to cover a clone
    // — fifteen minutes — so the boot sweep used to be refused this very row
    // and return silently, leaving the request owed forever. The window is
    // three missed heartbeats now, and a dead process misses all of them.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);

    const fresh = harness({}, h.store);
    await fresh.jobs.sweep();
    await fresh.jobs.drain();

    expect(h.store.all()[0]).toMatchObject({ status: 'opened', changeRequestNumber: 42 });
    expect(fresh.workflow.openChangeRequest).toHaveBeenCalledTimes(1);
  });

  it('a live process keeps its claim however long the work takes, by its own heartbeat', async () => {
    // The other half of the window, and the half that has to be tested
    // through the SERVICE. Beating the claim by calling `store.heartbeat`
    // from the test would prove only that the fake store refreshes a
    // timestamp; the thing that can actually regress is the interval `run`
    // installs. Nothing below touches the store by hand — the claim survives
    // only if the service is beating it.
    vi.useFakeTimers();
    const h = harness();
    const record = pendingRow(h.store);

    // A first-ever request is a full clone. This one hangs for well over the
    // stale window, which is the case the heartbeat exists for: without it
    // the work would be stolen out from under the process doing it.
    let finishClone = (): void => {};
    h.workflow.createBranch.mockReturnValue(
      new Promise((resolve) => {
        finishClone = () => resolve({ name: 'x', isDefault: false, isProtected: false });
      }) as never,
    );

    const flight = h.jobs.start(record);
    await vi.advanceTimersByTimeAsync(0); // the claim lands
    const beats = 4 * CLAIM_STALE_AFTER_MS;
    await vi.advanceTimersByTimeAsync(beats);

    // Four windows in, and still held — by the interval, and nothing else.
    const other = harness({}, h.store);
    await other.jobs.start({ ...record });
    expect(other.workflow.createBranch).not.toHaveBeenCalled();
    expect(h.store.all()[0].status).toBe('pending');

    // And it still completes: the beats did not disturb the work.
    finishClone();
    await flight;
    expect(h.store.all()[0]).toMatchObject({ status: 'opened', changeRequestNumber: 42 });
    expect(h.workflow.openChangeRequest).toHaveBeenCalledTimes(1);
  });

  it('stops before the change request when the row was erased under it', async () => {
    // Account erasure deletes a requester's recorded rows in a transaction
    // this job has no part in and cannot be told about. It lands here between
    // the commit and the change request — the worst moment, because what
    // comes next is the one step that leaves something a manager sees.
    const h = harness();
    const record = pendingRow(h.store);
    h.workflow.commitChanges.mockImplementation(async () => {
      h.store.deleteFor(ALI, 'Finance');
      return null;
    });

    await h.jobs.start(record);

    // No change request in a deleted person's name — and no row written back,
    // which would resurrect the ask the erasure just removed.
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
    expect(h.store.all()).toEqual([]);
  });

  it('settles nothing when its claim was taken over mid-work', async () => {
    // The straggler. This worker stalled past the window — a frozen host, a
    // partition that outlived three beats — and another process took the row
    // over and is doing the work now. Coming back to life, it must not open a
    // second change request, and must not stamp its own ending on the attempt
    // that replaced it.
    const h = harness();
    const record = pendingRow(h.store);
    h.workflow.commitChanges.mockImplementation(async () => {
      // A zero window is "the claim has lapsed", without minutes of fake time.
      await h.store.claim(record.id, 0);
      return null;
    });

    await h.jobs.start(record);

    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
    // Still pending, under the NEW claim: not `failed`, which is what an
    // unfenced worker would have written over a run that is going fine.
    expect(h.store.all()[0]).toMatchObject({ status: 'pending', failureReason: null });
  });

  it('will not push or open anything while ownership is unknown', async () => {
    // The beat THREW rather than answering. That is not "still mine" — the
    // database a replacement would have claimed through is exactly the
    // database that just refused to answer — so in front of an irreversible
    // step it has to read as "not mine".
    const h = harness();
    const record = pendingRow(h.store);
    const realHeartbeat = h.store.heartbeat.bind(h.store);
    let beats = 0;
    h.store.heartbeat = async (id: string, token: string) => {
      // Healthy up to the gate that stands in front of the git, then down.
      if (++beats > 1) throw new Error('the database went away');
      return realHeartbeat(id, token);
    };

    await h.jobs.start(record);

    // Nothing was written to the branch and nothing was opened — and the row
    // is left exactly as it was, pending, for the next sweep to redo.
    expect(h.workspaceService.writeFile).not.toHaveBeenCalled();
    expect(h.workflow.commitChanges).not.toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
    expect(h.store.all()[0]).toMatchObject({ status: 'pending', failureReason: null });
  });

  it('a database blip does not abandon work that is going fine', async () => {
    // The other direction, and the reason `unknown` is a third case rather
    // than a synonym for `lost`. The PERIODIC beat takes no action on its
    // answer, and the window is three beats wide exactly so one failed UPDATE
    // costs a beat rather than a clone that is running perfectly well.
    vi.useFakeTimers();
    const h = harness();
    const record = pendingRow(h.store);
    const realHeartbeat = h.store.heartbeat.bind(h.store);
    // Every beat from the interval fails; the gates' beats still succeed.
    let inGit = false;
    h.store.heartbeat = async (id: string, token: string) => {
      if (inGit) throw new Error('the database blipped');
      return realHeartbeat(id, token);
    };

    let finishClone = (): void => {};
    h.workflow.createBranch.mockReturnValue(
      new Promise((resolve) => {
        finishClone = () => resolve({ name: 'x', isDefault: false, isProtected: false });
      }) as never,
    );

    const flight = h.jobs.start(record);
    await vi.advanceTimersByTimeAsync(0);
    inGit = true;
    await vi.advanceTimersByTimeAsync(3 * CLAIM_STALE_AFTER_MS);
    inGit = false;

    // The interval swallowed every failure rather than tearing the job down.
    finishClone();
    await flight;
    expect(h.store.all()[0]).toMatchObject({ status: 'opened', changeRequestNumber: 42 });
  });

  it('checks the claim again after the clone, before it writes or pushes', async () => {
    // The gate before the git says nothing about who owns the row by the time
    // the clone returns, and a first-ever request clones the whole plugins
    // repository. So the row is taken over DURING the clone here: the write
    // and the push must not happen against a shared workspace this process no
    // longer has the right to touch.
    const h = harness();
    const record = pendingRow(h.store);
    h.workspaceService.getOrCreateForBranch = async (branch: string) => {
      await h.store.claim(record.id, 0); // the window lapsed; another worker took it
      return { id: workspaceIdForBranch(branch) };
    };

    await h.jobs.start(record);

    // The branch was created under a claim this process did hold — that is
    // idempotent and harmless — but nothing after the clone ran.
    expect(h.workspaceService.writeFile).not.toHaveBeenCalled();
    expect(h.workflow.commitChanges).not.toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });

  it('a superseded token can neither beat nor decide the row', async () => {
    // The fence itself, at the store: the contract `DbJoinRequestStore` puts
    // in SQL (`where claim_token = $token`) and this fake mirrors.
    const h = harness();
    const record = pendingRow(h.store);
    const first = await h.store.claim(record.id, CLAIM_STALE_AFTER_MS);
    const second = await h.store.claim(record.id, 0);
    expect(first?.claimToken).toBeTruthy();
    expect(second?.claimToken).not.toBe(first?.claimToken);

    await h.store.markOpened(record.id, second!.claimToken, 7);

    // Everything the superseded worker might still do, with the token it
    // believes it holds. All of it must be a no-op.
    expect(await h.store.heartbeat(record.id, first!.claimToken)).toBe(false);
    await h.store.markFailed(record.id, first!.claimToken, 'the git host went away');
    await h.store.markOpened(record.id, first!.claimToken, 99);
    await h.store.release(record.id, first!.claimToken);

    expect(h.store.all()[0]).toMatchObject({ status: 'opened', changeRequestNumber: 7 });
  });

  it('keeps sweeping on a tick, so a row nobody is working is picked up without a restart', async () => {
    vi.useFakeTimers();
    const h = harness();
    const record = pendingRow(h.store);
    // Held by a process that then died: the first sweep is refused it.
    await h.store.claim(record.id, CLAIM_STALE_AFTER_MS);

    h.jobs.startSweeping(1000);
    await vi.advanceTimersByTimeAsync(0);
    await h.jobs.drain();
    expect(h.store.all()[0].status).toBe('pending');

    // The claim goes stale, and the NEXT tick takes it — no restart involved.
    // Without the tick this row would wait for the next boot, which on a
    // healthy deployment may be days.
    vi.setSystemTime(Date.now() + CLAIM_STALE_AFTER_MS + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await h.jobs.drain();

    expect(h.store.all()[0]).toMatchObject({ status: 'opened', changeRequestNumber: 42 });
    h.jobs.stopSweeping();
  });

  it('stopSweeping ends the tick', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.jobs.startSweeping(1000);
    await vi.advanceTimersByTimeAsync(0);
    h.jobs.stopSweeping();

    pendingRow(h.store);
    await vi.advanceTimersByTimeAsync(5000);
    await h.jobs.drain();

    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });

  it('proceeds past a createBranch failure only when the branch is really there', async () => {
    const h = harness();
    const branch = joinBranchFor(ALI, 'Finance');
    h.workflow.createBranch.mockRejectedValue(new Error('a branch named that already exists'));
    h.workflow.listBranches.mockResolvedValue([{ name: branch }]);

    await h.jobs.start(pendingRow(h.store));

    expect(h.workflow.listBranches).toHaveBeenCalledWith(expect.any(String), {
      freshFetch: true,
      strictFetch: true,
    });
    expect(h.store.all()[0]).toMatchObject({ status: 'opened' });
  });

  it('fails the record when createBranch refuses and no branch exists to work against', async () => {
    const h = harness();
    h.workflow.createBranch.mockRejectedValue(new Error('remote: permission denied'));
    h.workflow.listBranches.mockResolvedValue([]);

    await h.jobs.start(pendingRow(h.store));

    // The old bare `catch {}` swallowed this and let every later step run
    // against a branch that was never created, so the requester read whatever
    // confused error fell out downstream instead of the real one.
    expect(h.store.all()[0]).toMatchObject({
      status: 'failed',
      failureReason: 'remote: permission denied',
    });
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses to splice when access.md is unreadable for any reason but absence', async () => {
    const h = harness();
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    h.workspaceService.readFile.mockRejectedValue(denied);

    await h.jobs.start(pendingRow(h.store));

    // Treating it as empty would have committed a file holding nothing but
    // this one request, wiping the plugin's real rules.
    expect(h.workspaceService.writeFile).not.toHaveBeenCalled();
    expect(h.store.all()[0]).toMatchObject({ status: 'failed' });
  });

  it('splices from nothing when access.md is merely absent', async () => {
    const h = harness();
    const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    h.workspaceService.readFile.mockRejectedValue(missing);

    await h.jobs.start(pendingRow(h.store));

    expect(h.workspaceService.writeFile).toHaveBeenCalled();
    expect(h.store.all()[0]).toMatchObject({ status: 'opened' });
  });

  it('keeps the request pending, and unclaimed, when the platform is not ready yet', async () => {
    const h = harness({
      target: async () => {
        throw new JoinRequestNotReadyError('the plugin catalog is not available yet');
      },
    });
    await h.jobs.start(pendingRow(h.store));

    // A knowledge base that has not finished cloning must not tell everyone
    // with a request outstanding that their plugin was deleted.
    const [row] = h.store.all();
    expect(row).toMatchObject({ status: 'pending', failureReason: null });
    // And the claim went back, so the next sweep picks it up at once rather
    // than waiting out a claim nothing is working behind.
    expect(row.claimedAt).toBeNull();
  });

  it('asks for a FRESH change-request listing before it opens a second one', async () => {
    const h = harness();
    await h.jobs.start(pendingRow(h.store));
    // A cached listing taken before an earlier attempt opened its change
    // request shows nothing to adopt, which is how a retry becomes a
    // duplicate.
    expect(h.workflow.listChangeRequestsAuthoredBy).toHaveBeenCalledWith(ALI, { fresh: true });
  });

});
