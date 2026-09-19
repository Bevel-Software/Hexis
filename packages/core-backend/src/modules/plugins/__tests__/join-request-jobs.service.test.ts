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
    vi.useRealTimers();
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
    vi.useRealTimers();
  });

  it('a live process keeps its claim however long the work takes', async () => {
    // The other half: the heartbeat must hold a claim past the stale window
    // for work that is genuinely still running, or a first-ever clone would
    // be stolen out from under the process doing it.
    const h = harness();
    const record = pendingRow(h.store);
    await h.store.claim(record.id, CLAIM_STALE_AFTER_MS);

    // Long past the window — but the process is alive and beating.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    await h.store.heartbeat(record.id);

    const other = harness({}, h.store);
    await other.jobs.start({ ...record });

    expect(other.workflow.createBranch).not.toHaveBeenCalled();
    expect(h.store.all()[0].status).toBe('pending');
    vi.useRealTimers();
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
    vi.useRealTimers();
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
    vi.useRealTimers();
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
