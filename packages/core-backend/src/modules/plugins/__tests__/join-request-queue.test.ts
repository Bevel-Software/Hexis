import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_BRANCH, joinBranchFor, type ChangeRequest, type IWorkflowService } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import {
  PluginJoinRequestsQueue,
  reasonOf,
  type JoinRequestStore,
  type StoredRequest,
  type StoredRequestSeed,
} from '../join-request-queue.service.js';

/**
 * The queue's own promises, with the database replaced by an in-memory store
 * that keeps the one rule the real table enforces: (requester, plugin) is
 * unique, and only the caller whose insert WON is told so.
 *
 * What is under test is the ordering the ticket exists for — the record is
 * written before any git work, the git work happens after, and a record
 * survives to be finished (or failed) by the next boot.
 */

const ALI = 'ali@bevel.software';
const KB = 'knowledge-base';
const USER = { id: 'u-1', email: ALI, name: 'Ali Baba' };

/** The unique index, an array, and nothing else. */
class FakeStore implements JoinRequestStore {
  rows: StoredRequest[] = [];
  private seq = 0;

  async insertIfAbsent(seed: StoredRequestSeed) {
    const existing = this.rows.find(
      (r) => r.requesterEmail === seed.requesterEmail && r.pluginKey === seed.pluginKey,
    );
    if (existing) return { row: { ...existing }, inserted: false };
    const row: StoredRequest = {
      ...seed,
      id: `rec-${++this.seq}`,
      status: 'pending',
      changeRequestNumber: null,
      failureReason: null,
      attempts: 1,
    };
    this.rows.push(row);
    return { row: { ...row }, inserted: true };
  }

  async reopenIfFailed(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.status !== 'failed') return null;
    row.status = 'pending';
    row.failureReason = null;
    row.attempts += 1;
    return { ...row };
  }

  async byId(id: string) {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async byRequester(email: string) {
    return this.rows.filter((r) => r.requesterEmail === email).map((r) => ({ ...r }));
  }

  async allPending() {
    return this.rows.filter((r) => r.status === 'pending').map((r) => ({ ...r }));
  }

  async markOpened(id: string, changeRequestNumber: number) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.status = 'opened';
    row.changeRequestNumber = changeRequestNumber;
    row.failureReason = null;
  }

  async markFailed(id: string, reason: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.status = 'failed';
    row.failureReason = reason;
  }

  async remove(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}

function makeQueue(over: { authoredCrs?: ChangeRequest[]; accessText?: string } = {}) {
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: workspaceIdForBranch(branch) })),
    readFile: vi.fn(async () => over.accessText ?? '---\nread:\n  - everyone\n---\nread: []\n'),
    writeFile: vi.fn(async () => undefined),
  } as unknown as WorkspaceService;

  const workflow = {
    listChangeRequestsAuthoredBy: vi.fn(async () => over.authoredCrs ?? []),
    createBranch: vi.fn(async () => ({ name: 'x', isDefault: false, isProtected: false })),
    commitChanges: vi.fn(async () => null),
    openChangeRequest: vi.fn(async () => ({ number: 42 })),
  } as unknown as IWorkflowService;

  const store = new FakeStore();
  const queue = new PluginJoinRequestsQueue(store, workspaceService, workflow, KB);
  return { queue, store, workspaceService, workflow };
}

/** Let the background chain advance without settling what it is blocked on. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const ASK = {
  user: USER,
  pluginKey: 'Finance',
  pluginFolder: 'Plugins/Finance',
  pluginDisplayName: 'Finance',
};

describe('PluginJoinRequestsQueue', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('records the request BEFORE any git work, and answers without waiting for it', async () => {
    const { queue, store, workflow } = makeQueue();
    // A change request that never settles: the whole point is that `request`
    // does not wait for it.
    let openIt = () => {};
    (workflow.openChangeRequest as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        openIt = () => resolve({ number: 42 });
      }),
    );

    const record = await queue.request(ASK);

    expect(record).toMatchObject({ status: 'pending', changeRequestNumber: null });
    // Recorded already — this is what the plugin index reads a moment later.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ requesterEmail: ALI, pluginKey: 'Finance', status: 'pending' });
    // And the git work had not even reached the change request when the
    // caller was answered — it runs on, afterwards, while the row stays
    // pending and the page shows the "Requested" card.
    expect(workflow.openChangeRequest).not.toHaveBeenCalled();
    await tick();
    expect(workflow.openChangeRequest).toHaveBeenCalled();
    expect(store.rows[0].status).toBe('pending');

    openIt();
    await queue.whenIdle();
    expect(store.rows[0]).toMatchObject({ status: 'opened', changeRequestNumber: 42 });
  });

  it('does the SAME git work the route used to do inline: branch, splice, commit, change request', async () => {
    const { queue, store, workspaceService, workflow } = makeQueue();
    await queue.request(ASK);
    await queue.whenIdle();

    const branch = joinBranchFor(ALI, 'Finance');
    expect(workflow.createBranch).toHaveBeenCalledWith(expect.any(String), branch, DEFAULT_BRANCH);
    const write = (workspaceService.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(write[1]).toBe(`${KB}/Plugins/Finance/access.md`);
    expect(write[2]).toContain('Ali Baba <ali@bevel.software>');
    expect(workflow.commitChanges).toHaveBeenCalled();
    expect(workflow.openChangeRequest).toHaveBeenCalledWith(
      workspaceIdForBranch(branch),
      expect.objectContaining({ email: ALI, name: 'Ali Baba' }),
      expect.objectContaining({
        sourceBranch: branch,
        targetBranch: DEFAULT_BRANCH,
        title: 'Join request: Finance',
      }),
    );
    expect(store.rows[0].status).toBe('opened');
  });

  it('two clicks record ONE request and open ONE change request', async () => {
    const { queue, store, workflow } = makeQueue();
    const [a, b] = await Promise.all([queue.request(ASK), queue.request(ASK)]);
    await queue.whenIdle();

    expect(a.id).toBe(b.id);
    expect(store.rows).toHaveLength(1);
    expect(workflow.createBranch).toHaveBeenCalledTimes(1);
    expect(workflow.openChangeRequest).toHaveBeenCalledTimes(1);
  });

  it('marks the record failed with the reason when the background work throws', async () => {
    const { queue, store, workflow } = makeQueue();
    (workflow.openChangeRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('remote: Invalid username or password.'),
    );
    const record = await queue.request(ASK);
    // The CALL still succeeded — the person was told their click was heard.
    expect(record.status).toBe('pending');
    await queue.whenIdle();
    expect(store.rows[0]).toMatchObject({
      status: 'failed',
      failureReason: 'remote: Invalid username or password',
    });
  });

  it('a click on a FAILED record retries that same record — never a second one', async () => {
    const { queue, store, workflow } = makeQueue();
    const open = workflow.openChangeRequest as ReturnType<typeof vi.fn>;
    open.mockRejectedValueOnce(new Error('push rejected'));
    await queue.request(ASK);
    await queue.whenIdle();
    expect(store.rows[0].status).toBe('failed');

    const retried = await queue.request(ASK);
    await queue.whenIdle();
    expect(retried.id).toBe(store.rows[0].id);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: 'opened', changeRequestNumber: 42, attempts: 2 });
  });

  it('a click on a request already pending starts nothing new', async () => {
    const { queue, store, workflow } = makeQueue();
    store.rows.push({
      ...ASK.user,
      id: 'rec-existing',
      requesterEmail: ALI,
      requesterName: 'Ali Baba',
      requesterUserId: 'u-1',
      pluginKey: 'Finance',
      pluginFolder: 'Plugins/Finance',
      pluginDisplayName: 'Finance',
      status: 'pending',
      changeRequestNumber: null,
      failureReason: null,
      attempts: 1,
    });
    const record = await queue.request(ASK);
    await queue.whenIdle();
    expect(record.id).toBe('rec-existing');
    // The boot sweep owns a pending row nobody is working; a click must not
    // race it for the same clone.
    expect(workflow.createBranch).not.toHaveBeenCalled();
  });

  it('adopts an existing open change request instead of opening a second one', async () => {
    const existing = {
      number: 9,
      state: 'open',
      branch: joinBranchFor(ALI, 'Finance'),
    } as ChangeRequest;
    const { queue, store, workflow } = makeQueue({ authoredCrs: [existing] });
    await queue.request(ASK);
    await queue.whenIdle();
    expect(store.rows[0]).toMatchObject({ status: 'opened', changeRequestNumber: 9 });
    expect(workflow.openChangeRequest).not.toHaveBeenCalled();
    expect(workflow.createBranch).not.toHaveBeenCalled();
  });

  it('the boot sweep finishes a request a restart caught mid-flight', async () => {
    const { queue, store, workflow } = makeQueue();
    // What a process that died between "recorded" and "change request" leaves.
    store.rows.push({
      id: 'rec-orphan',
      requesterEmail: ALI,
      requesterName: 'Ali Baba',
      requesterUserId: 'u-1',
      pluginKey: 'Finance',
      pluginFolder: 'Plugins/Finance',
      pluginDisplayName: 'Finance',
      status: 'pending',
      changeRequestNumber: null,
      failureReason: null,
      attempts: 1,
    });

    await queue.sweep();
    await queue.whenIdle();

    expect(store.rows[0]).toMatchObject({ status: 'opened', changeRequestNumber: 42 });
    expect(workflow.openChangeRequest).toHaveBeenCalledTimes(1);
  });

  it('the boot sweep FAILS what it cannot finish, rather than leaving it pending forever', async () => {
    const { queue, store, workflow } = makeQueue();
    (workflow.openChangeRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('git host down'));
    store.rows.push({
      id: 'rec-orphan',
      requesterEmail: ALI,
      requesterName: 'Ali Baba',
      requesterUserId: 'u-1',
      pluginKey: 'Finance',
      pluginFolder: 'Plugins/Finance',
      pluginDisplayName: 'Finance',
      status: 'pending',
      changeRequestNumber: null,
      failureReason: null,
      attempts: 1,
    });

    await queue.sweep();
    await queue.whenIdle();
    expect(store.rows[0]).toMatchObject({ status: 'failed', failureReason: 'git host down' });
  });

  it('the sweep leaves an opened or failed record alone', async () => {
    const { queue, store, workflow } = makeQueue();
    store.rows.push(
      {
        id: 'a', requesterEmail: ALI, requesterName: 'A', requesterUserId: 'u-1',
        pluginKey: 'Finance', pluginFolder: 'Plugins/Finance', pluginDisplayName: 'Finance',
        status: 'opened', changeRequestNumber: 3, failureReason: null, attempts: 1,
      },
      {
        id: 'b', requesterEmail: ALI, requesterName: 'A', requesterUserId: 'u-1',
        pluginKey: 'GTM', pluginFolder: 'Plugins/GTM', pluginDisplayName: 'GTM',
        status: 'failed', changeRequestNumber: null, failureReason: 'nope', attempts: 1,
      },
    );
    await queue.sweep();
    await queue.whenIdle();
    expect(workflow.createBranch).not.toHaveBeenCalled();
    expect(store.rows.map((r) => r.status)).toEqual(['opened', 'failed']);
  });

  it('keys records by the requester, canonicalised, and reports them by plugin key', async () => {
    const { queue } = makeQueue();
    await queue.request({ ...ASK, user: { ...USER, email: ' Ali@Bevel.Software ' } });
    await queue.whenIdle();
    const byPlugin = await queue.byRequester('ALI@bevel.software');
    expect(byPlugin.get('Finance')).toMatchObject({ status: 'opened', changeRequestNumber: 42 });
  });

  it('retires a record on request — how a settled change request lets the button back', async () => {
    const { queue, store } = makeQueue();
    const record = await queue.request(ASK);
    await queue.whenIdle();
    await queue.retire(record.id);
    expect(store.rows).toHaveLength(0);
  });

  it('leaves the row pending for the next boot when even recording the failure fails', async () => {
    const { queue, store, workflow } = makeQueue();
    (workflow.openChangeRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    vi.spyOn(store, 'markFailed').mockRejectedValue(new Error('database gone'));

    await expect(queue.request(ASK)).resolves.toMatchObject({ status: 'pending' });
    await queue.whenIdle();

    // Nothing escaped into an unhandled rejection, and the record is still
    // pending — which is exactly what the boot sweep picks up.
    expect(errors).toHaveBeenCalled();
    expect(store.rows[0].status).toBe('pending');
  });
});

describe('reasonOf', () => {
  it('takes one line, drops trailing punctuation, and never comes back empty', () => {
    expect(reasonOf(new Error('remote: permission denied.\n  at push (git.ts:1)'))).toBe(
      'remote: permission denied',
    );
    expect(reasonOf(new Error('   '))).toBe('the platform did not say why');
    expect(reasonOf('plain string')).toBe('plain string');
  });

  it('bounds a reason that would otherwise be a paragraph', () => {
    const reason = reasonOf(new Error('x'.repeat(500)));
    expect(reason).toHaveLength(198);
    expect(reason.endsWith('…')).toBe(true);
  });
});
