import { describe, expect, it } from 'vitest';
import { AdminAccessService } from '../admin-access.service.js';
import type { IAccessControl } from '../../access/index.js';
import type { WorkspaceService } from '../../workspace/index.js';

function service(canWrite: () => Promise<boolean>): AdminAccessService {
  const access = { canWrite } as unknown as IAccessControl;
  const ws = { getOrCreateForBranch: async () => undefined } as unknown as WorkspaceService;
  return new AdminAccessService(access, ws, 'main', ['owner@acme.test']);
}

describe('AdminAccessService', () => {
  it('a failed read is "not admin" to isAdmin and a throw from holdsAdmin', async () => {
    const admins = service(async () => {
      throw new Error('roles.yaml unreadable');
    });
    expect(await admins.isAdmin('boss@acme.test')).toBe(false);
    await expect(admins.holdsAdmin('boss@acme.test')).rejects.toThrow('roles.yaml unreadable');
  });

  it('both answer from roles.yaml when it reads, and the configured owner is always an admin', async () => {
    const admins = service(async () => true);
    expect(await admins.isAdmin('boss@acme.test')).toBe(true);
    expect(await admins.holdsAdmin('boss@acme.test')).toBe(true);
    const failing = service(async () => {
      throw new Error('roles.yaml unreadable');
    });
    expect(await failing.holdsAdmin('Owner@Acme.test')).toBe(true);
  });
});
