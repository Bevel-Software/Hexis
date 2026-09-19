import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_BRANCH, joinBranchFor } from '@bevel-software/platform-shared';
import { PluginJoinRequestJobs, type JoinRequestJobsDeps } from '../join-request-jobs.service.js';
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

function harness(over: Partial<JoinRequestJobsDeps> = {}) {
  const workflow = {
    listChangeRequestsAuthoredBy: vi.fn(async () => [] as never[]),
    createBranch: vi.fn(async () => ({ name: 'x', isDefault: false, isProtected: false })),
    commitChanges: vi.fn(async () => null),
    openChangeRequest: vi.fn(async () => ({ number: 42 })),
  };
  const workspaceService = {
    getOrCreateForBranch: async (branch: string) => ({ id: workspaceIdForBranch(branch) }),
    readFile: vi.fn(async () => ACCESS_MD),
    writeFile: vi.fn(async () => undefined),
  };
  const store = new FakeJoinRequestStore();
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
  });
}

describe('PluginJoinRequestJobs', () => {
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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    h.workflow.openChangeRequest.mockRejectedValue(
      new Error("fatal: unable to access 'https://x-access-token:ghp_secret@github.com/acme/kb'"),
    );
    await h.jobs.start(pendingRow(h.store));

    const [row] = h.store.all();
    expect(row.status).toBe('failed');
    expect(row.failureReason).toContain('unable to access');
    expect(row.failureReason).not.toContain('ghp_secret');
    error.mockRestore();
  });

  it('fails the record rather than throwing when the plugin is gone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ target: async () => null });
    await expect(h.jobs.start(pendingRow(h.store))).resolves.toBeUndefined();
    expect(h.store.all()).toMatchObject([
      { status: 'failed', failureReason: 'the plugin is no longer available' },
    ]);
    expect(h.workflow.createBranch).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('fails the record when no account answers to the address that asked', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ requester: async () => null });
    await h.jobs.start(pendingRow(h.store));
    expect(h.store.all()).toMatchObject([
      { status: 'failed', failureReason: 'the account that asked no longer exists' },
    ]);
    error.mockRestore();
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
    });
    h.store.seed({
      requesterEmail: 'mia@bevel.software',
      requesterName: 'Mia',
      pluginKey: 'Ops',
      status: 'failed',
      failureReason: 'the remote refused the push',
      changeRequestNumber: null,
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
});
