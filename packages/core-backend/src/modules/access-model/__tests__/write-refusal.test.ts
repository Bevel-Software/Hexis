import { describe, it, expect, vi } from 'vitest';
import { unwritableRefusal, type ChangeReadVerdict, type IChangeReadGate } from '../index.js';

const WS = 'ws-1';
const EMAIL = 'ana@example.com';
const WS_PATH = 'knowledge-base/Sales/Locked';

function gates(verdict: ChangeReadVerdict) {
  const judge = vi.fn(async () => verdict);
  const changeGate: IChangeReadGate = { judge, assertMayChange: vi.fn() };
  const accessControl = {
    eligibleWritersAtRef: vi.fn(async () => ({ roles: ['Sales Lead'], users: [{ name: 'Owner', email: 'owner@x' }] })),
  };
  return { gates: { accessControl, changeGate }, judge, accessControl };
}

describe('unwritableRefusal', () => {
  it('refuses a path the caller may not read for the read, without asking who may write it', async () => {
    const { gates: g, judge, accessControl } = gates({ allowed: false, unreadable: 'Sales/Locked' });

    const err = await unwritableRefusal(g, WS, EMAIL, { wsPath: WS_PATH, repoRelative: 'Sales/Locked', kind: 'dir' });

    expect(judge).toHaveBeenCalledWith(WS, EMAIL, WS_PATH, 'dir');
    expect(accessControl.eligibleWritersAtRef).not.toHaveBeenCalled();
    expect(err.status).toBe(403);
    expect(err.access).toEqual({ path: WS_PATH, eligibleRoles: [], eligibleUsers: [], unreadable: 'Sales/Locked', targetKind: 'dir' });
    expect(err.message).toContain('You don\'t have read access to "Sales/Locked"');
  });

  it('names who may write a readable path at HEAD, asked at its repository-relative path', async () => {
    const { gates: g, accessControl } = gates({ allowed: true, via: 'readable' });

    const err = await unwritableRefusal(g, WS, EMAIL, { wsPath: WS_PATH, repoRelative: 'Sales/Locked', kind: 'file' });

    expect(accessControl.eligibleWritersAtRef).toHaveBeenCalledWith(WS, 'HEAD', 'Sales/Locked');
    expect(err.status).toBe(403);
    expect(err.access).toEqual({
      path: WS_PATH,
      eligibleRoles: ['Sales Lead'],
      eligibleUsers: [{ name: 'Owner', email: 'owner@x' }],
      targetKind: 'file',
    });
    expect(err.message).toBe(`You don't have permission to write to "${WS_PATH}". Eligible: Sales Lead; Owner <owner@x>.`);
  });
});
