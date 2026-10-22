import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdminAccessService } from '../admin-access.service.js';
import { setLogger, type ILogger } from '../../../shared/logging.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';

/** The admin check over a clone that records its calls and a roles.yaml that names one lead. */
function harness(
  branch: string | (() => string),
  bootstrapAdmins: string[] = [],
  opts: { cloneFails?: boolean; rolesFail?: boolean } = {},
) {
  const calls: string[] = [];
  const ws = {
    getOrCreateForBranch: async (b: string) => {
      calls.push(`clone:${b}`);
      if (opts.cloneFails) throw new Error('the remote said no');
      return {};
    },
  } as unknown as WorkspaceService;
  const access = {
    canWrite: async (_ws: string, email: string) => {
      calls.push(`roles:${email}`);
      if (opts.rolesFail) throw new Error('roles.yaml: bad indentation');
      return email === 'lead@acme.test';
    },
  } as unknown as IAccessControl;
  return { service: new AdminAccessService(access, ws, branch, bootstrapAdmins), calls };
}

const warned: string[] = [];
const recording: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message) => {
    warned.push(message);
  },
  error: () => undefined,
  child: () => recording,
};

describe('AdminAccessService.isAdmin', () => {
  let previous: ILogger;
  beforeEach(() => {
    warned.length = 0;
    previous = setLogger(recording);
  });
  afterEach(() => {
    setLogger(previous);
  });

  it('before the branch model is set, the bootstrap admin and nobody else — with no clone attempt and no warning', async () => {
    const h = harness('', ['owner@acme.test']);
    expect(await h.service.isAdmin('Owner@acme.test')).toBe(true);
    expect(await h.service.isAdmin('lead@acme.test')).toBe(false);
    expect(await h.service.isAdmin(undefined)).toBe(false);
    expect(h.calls).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('with a branch model, roles.yaml on that branch decides once its clone is on disk', async () => {
    const h = harness('main', ['owner@acme.test']);
    expect(await h.service.isAdmin('owner@acme.test')).toBe(true);
    expect(await h.service.isAdmin('lead@acme.test')).toBe(true);
    expect(await h.service.isAdmin('someone@acme.test')).toBe(false);
    expect(h.calls).toEqual(['clone:main', 'roles:lead@acme.test', 'clone:main', 'roles:someone@acme.test']);
    expect(warned).toEqual([]);
  });

  it('a clone that fails makes nobody an admin, and says so', async () => {
    const h = harness('main', [], { cloneFails: true });
    expect(await h.service.isAdmin('lead@acme.test')).toBe(false);
    expect(warned).toEqual(['isAdmin resolution failed:']);
  });

  it('a roles file that cannot be read makes nobody an admin, and says so', async () => {
    const h = harness('main', [], { rolesFail: true });
    expect(await h.service.isAdmin('lead@acme.test')).toBe(false);
    expect(h.calls).toEqual(['clone:main', 'roles:lead@acme.test']);
    expect(warned).toEqual(['isAdmin resolution failed:']);
  });

  it('a branch that cannot be resolved makes nobody an admin, and says so', async () => {
    const h = harness(
      () => {
        throw new Error('no branch model');
      },
      ['owner@acme.test'],
    );
    expect(await h.service.isAdmin('owner@acme.test')).toBe(true);
    expect(await h.service.isAdmin('lead@acme.test')).toBe(false);
    expect(h.calls).toEqual([]);
    expect(warned).toEqual(['isAdmin resolution failed:']);
  });
});
