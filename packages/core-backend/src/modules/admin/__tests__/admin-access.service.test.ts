import { describe, expect, it, vi } from 'vitest';
import { AdminAccessService } from '../admin-access.service.js';
import type { IAccessControl } from '../../access/index.js';
import type { WorkspaceService } from '../../workspace/index.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';

/** The service over spies, so each test can say which workspace and file it asked. */
function service(canWrite: (workspaceId: string, email: string, path: string) => Promise<boolean>) {
  const canWriteSpy = vi.fn(canWrite);
  const getOrCreateForBranch = vi.fn<(branch: string) => Promise<undefined>>(async () => undefined);
  const access = { canWrite: canWriteSpy } as unknown as IAccessControl;
  const ws = { getOrCreateForBranch } as unknown as WorkspaceService;
  const admins = new AdminAccessService(access, ws, 'main', ['owner@acme.test']);
  return { admins, canWrite: canWriteSpy, getOrCreateForBranch };
}

describe('AdminAccessService', () => {
  it('a failed read is "not admin" to isAdmin and a throw from holdsAdmin', async () => {
    const { admins } = service(async () => {
      throw new Error('roles.yaml unreadable');
    });
    expect(await admins.isAdmin('boss@acme.test')).toBe(false);
    await expect(admins.holdsAdmin('boss@acme.test')).rejects.toThrow('roles.yaml unreadable');
  });

  it('both answer from roles.yaml when it reads, and the configured owner is always an admin', async () => {
    const { admins } = service(async () => true);
    expect(await admins.isAdmin('boss@acme.test')).toBe(true);
    expect(await admins.holdsAdmin('boss@acme.test')).toBe(true);
    const failing = service(async () => {
      throw new Error('roles.yaml unreadable');
    });
    expect(await failing.admins.holdsAdmin('Owner@Acme.test')).toBe(true);
  });

  it("asks the configured branch's workspace whether the address may write roles.yaml, and nothing else", async () => {
    const { admins, canWrite, getOrCreateForBranch } = service(
      async (workspaceId, email, path) =>
        workspaceId === workspaceIdForBranch('main') && email === 'boss@acme.test' && path === 'roles.yaml',
    );
    expect(await admins.holdsAdmin('boss@acme.test')).toBe(true);
    expect(await admins.isAdmin('boss@acme.test')).toBe(true);
    expect(getOrCreateForBranch.mock.calls).toEqual([['main'], ['main']]);
    expect(canWrite.mock.calls).toEqual([
      [workspaceIdForBranch('main'), 'boss@acme.test', 'roles.yaml'],
      [workspaceIdForBranch('main'), 'boss@acme.test', 'roles.yaml'],
    ]);
    // Another address, the same question about it.
    expect(await admins.holdsAdmin('someone@acme.test')).toBe(false);
  });
});
