import { describe, expect, it, vi } from 'vitest';
import type { BranchSyncOutcome } from '@bevel-software/platform-shared';
import { KbSyncService } from '../kb-sync.service.js';
import type { SyncWorkflowPort, SyncWorkspacePort } from '../kb-sync.interface.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function workspaces(branches: string[]): SyncWorkspacePort {
  return {
    listClonedWorkspaces: async () => branches.map((branch) => ({ id: encodeURIComponent(branch), branch })),
  };
}

function updated(branch: string): BranchSyncOutcome {
  return { branch, outcome: 'updated', from: 'aaa', to: 'bbb' };
}

describe('KbSyncService', () => {
  it('syncs every known clone for an "all" request and reports unknown branches as not cloned', async () => {
    const workflow: SyncWorkflowPort = {
      syncWorkspaceFromRemote: vi.fn(async (id: string) => updated(decodeURIComponent(id))),
      closeChangeRequestsWithDeletedBranches: vi.fn(async () => 1),
    };
    const svc = new KbSyncService(workflow, workspaces(['main', 'ali/x']));

    const all = await svc.sync({ branches: 'all' });
    expect(all.status).toBe('synced');
    expect(all.results.map((r) => r.branch)).toEqual(['main', 'ali/x']);
    expect(all.changeRequests.closedDeletedBranch).toBe(1);
    expect(workflow.syncWorkspaceFromRemote).toHaveBeenCalledWith('ali%2Fx');

    const some = await svc.sync({ branches: ['ali/x', 'juan/other'] });
    expect(some.results).toEqual([updated('ali/x'), { branch: 'juan/other', outcome: 'not-cloned' }]);
  });

  it('a conflict or an error makes the result partial; the other branches still sync', async () => {
    const workflow: SyncWorkflowPort = {
      syncWorkspaceFromRemote: vi.fn(async (id: string): Promise<BranchSyncOutcome> =>
        id === 'main'
          ? { branch: 'main', outcome: 'conflict', conflictedPaths: ['a.md'], error: 'msg' }
          : updated(decodeURIComponent(id)),
      ),
      closeChangeRequestsWithDeletedBranches: vi.fn(async () => 0),
    };
    const svc = new KbSyncService(workflow, workspaces(['main', 'ali/x']));
    const r = await svc.sync({ branches: 'all' });
    expect(r.status).toBe('partial');
    expect(r.results[1]).toEqual(updated('ali/x'));
  });

  it('a failing sweep does not fail the sync', async () => {
    const workflow: SyncWorkflowPort = {
      syncWorkspaceFromRemote: vi.fn(async () => updated('main')),
      closeChangeRequestsWithDeletedBranches: vi.fn(async () => {
        throw new Error('origin down');
      }),
    };
    const svc = new KbSyncService(workflow, workspaces(['main']));
    const r = await svc.sync({ branches: 'all' });
    expect(r.status).toBe('synced');
    expect(r.changeRequests.closedDeletedBranch).toBe(0);
  });

  it('coalesces everything that arrives mid-run into ONE follow-up carrying the union', async () => {
    const gate = deferred<void>();
    // Each run's branches, in order. The first run parks on `gate` so the
    // others arrive mid-run; a new run is recognised by its first branch
    // landing after the gate opened.
    const calls: string[][] = [['']];
    let gateOpened = false;
    const workflow: SyncWorkflowPort = {
      syncWorkspaceFromRemote: vi.fn(async (id: string) => {
        const branch = decodeURIComponent(id);
        if (!gateOpened && branch === 'main') {
          await gate.promise;
          gateOpened = true;
          calls[0] = [];
        } else if (gateOpened && calls.length === 1) {
          calls.push([]);
        }
        calls[calls.length - 1].push(branch);
        return updated(branch);
      }),
      closeChangeRequestsWithDeletedBranches: vi.fn(async () => 0),
    };
    const svc = new KbSyncService(workflow, workspaces(['main', 'ali/x', 'juan/y']));

    const first = svc.sync({ branches: ['main'] });
    // Three requests land while the first is parked on `gate`.
    const second = svc.sync({ branches: ['ali/x'] });
    const third = svc.sync({ branches: ['juan/y'] });
    const fourth = svc.sync({ branches: ['ali/x'] });
    gate.resolve();

    const [r1, r2, r3, r4] = await Promise.all([first, second, third, fourth]);
    expect(r1.results.map((r) => r.branch)).toEqual(['main']);
    // One follow-up, the union, in arrival order — and every mid-run caller
    // got that same result.
    expect(calls).toEqual([['main'], ['ali/x', 'juan/y']]);
    expect(r2).toBe(r3);
    expect(r3).toBe(r4);
    expect(r2.results.map((r) => r.branch)).toEqual(['ali/x', 'juan/y']);
    expect(workflow.closeChangeRequestsWithDeletedBranches).toHaveBeenCalledTimes(2);
  });

  it('an "all" arriving mid-run absorbs the queued branches', async () => {
    const gate = deferred<void>();
    const workflow: SyncWorkflowPort = {
      syncWorkspaceFromRemote: vi.fn(async (id: string) => {
        if (id === 'main') await gate.promise;
        return updated(decodeURIComponent(id));
      }),
      closeChangeRequestsWithDeletedBranches: vi.fn(async () => 0),
    };
    const svc = new KbSyncService(workflow, workspaces(['main', 'ali/x', 'juan/y']));
    const first = svc.sync({ branches: ['main'] });
    const second = svc.sync({ branches: ['ali/x'] });
    const third = svc.sync({ branches: 'all' });
    gate.resolve();
    await first;
    const r = await second;
    expect(await third).toBe(r);
    expect(r.results.map((x) => x.branch)).toEqual(['main', 'ali/x', 'juan/y']);
  });
});

describe('KbSyncService.lastSync', () => {
  it('is null before the first sync, then records when, who and what', async () => {
    const workflow: SyncWorkflowPort = {
      syncWorkspaceFromRemote: vi.fn(async (id: string) => updated(decodeURIComponent(id))),
      closeChangeRequestsWithDeletedBranches: vi.fn(async () => 0),
    };
    let clock = 1_000;
    const svc = new KbSyncService(workflow, workspaces(['main']), () => clock);
    expect(svc.lastSync()).toBeNull();

    await svc.sync({ branches: 'all', by: 'bearer' });
    expect(svc.lastSync()).toEqual({
      at: 1_000,
      by: 'bearer',
      status: 'synced',
      results: [updated('main')],
    });

    clock = 2_000;
    await svc.sync({ branches: ['main'], by: 'admin@example.com' });
    expect(svc.lastSync()).toMatchObject({ at: 2_000, by: 'admin@example.com' });
  });

  it('a coalesced follow-up names everyone who asked for it', async () => {
    const gate = deferred<void>();
    const workflow: SyncWorkflowPort = {
      syncWorkspaceFromRemote: vi.fn(async (id: string) => {
        if (id === 'main') await gate.promise;
        return updated(decodeURIComponent(id));
      }),
      closeChangeRequestsWithDeletedBranches: vi.fn(async () => 0),
    };
    const svc = new KbSyncService(workflow, workspaces(['main', 'ali/x']));
    const first = svc.sync({ branches: ['main'], by: 'bearer' });
    const second = svc.sync({ branches: ['ali/x'], by: 'github-signature' });
    const third = svc.sync({ branches: ['ali/x'], by: 'admin@example.com' });
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(svc.lastSync()?.by).toBe('github-signature, admin@example.com');
  });
});

describe('KbSyncService — a throwing branch step', () => {
  it('becomes an error outcome; the other branches, the sweep and the record all still happen', async () => {
    const workflow: SyncWorkflowPort = {
      syncWorkspaceFromRemote: vi.fn(async (id: string) => {
        if (id === 'main') throw new Error('fatal: unable to access https://x:ghp_secret@host/r');
        return updated(decodeURIComponent(id));
      }),
      closeChangeRequestsWithDeletedBranches: vi.fn(async () => 1),
    };
    const svc = new KbSyncService(workflow, workspaces(['main', 'ali/x']));
    const r = await svc.sync({ branches: 'all', by: 'bearer' });
    expect(r.status).toBe('partial');
    expect(r.results[0]).toMatchObject({ branch: 'main', outcome: 'error' });
    expect((r.results[0] as { error: string }).error).not.toContain('ghp_secret');
    expect(r.results[1]).toEqual(updated('ali/x'));
    expect(r.changeRequests.closedDeletedBranch).toBe(1);
    expect(svc.lastSync()?.status).toBe('partial');
  });
});
