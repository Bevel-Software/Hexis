import { describe, it, expect, vi } from 'vitest';
import { writeDenial } from '../write-denial.js';
import { AccessDeniedError } from '../../access-model/access-errors.js';
import type { ChangeReadVerdict, IChangeReadGate } from '../../access-model/change-gate.js';
import type { IAccessControl } from '../../access/access-control.interface.js';

/**
 * The `write-denied` answer's "may you propose this instead?" is the read
 * gate's question, asked about the refused path AS WHAT IT IS: a folder a
 * move or delete was judged on, or a file. A folder directly under a root is
 * proposable where a file there is not, so the kind the refuser recorded is
 * what decides — never a guess from the path's spelling.
 */

const KB = 'knowledge-base';
// One of the branches the backend test config marks protected.
const PROTECTED = 'target-company-state';
const INPUT = { tool: 'move_file', branch: PROTECTED, userEmail: 'alice@example.com', userId: 'u1' };

function gateThat(verdict: ChangeReadVerdict) {
  const judge = vi.fn(async () => verdict);
  const gate: IChangeReadGate = { judge, assertMayChange: vi.fn() };
  return { gate, judge };
}

const noAccess = {} as unknown as IAccessControl;

describe('writeDenial asks the read gate about the refused path as the refuser saw it', () => {
  it('a folder refusal is judged as a folder — a new root folder is then proposable', async () => {
    const { gate, judge } = gateThat({ allowed: true, via: 'new-top-level-folder' });
    const err = new AccessDeniedError({
      path: `${KB}/KnowledgeBase/Projects`,
      eligibleRoles: ['Admin'],
      eligibleUsers: [],
      targetKind: 'dir',
    });
    const out = await writeDenial(err, INPUT, noAccess, KB, gate);
    expect(judge).toHaveBeenCalledWith(
      'target-company-state',
      'alice@example.com',
      `${KB}/KnowledgeBase/Projects`,
      'dir',
    );
    expect(out.status).toBe(403);
    expect(out.details).toMatchObject({ kind: 'write-denied', canPropose: true });
  });

  it('a refusal that says nothing about its kind is judged as a file', async () => {
    const { gate, judge } = gateThat({ allowed: false, unreadable: 'KnowledgeBase' });
    const err = new AccessDeniedError({ path: `${KB}/KnowledgeBase/loose.md`, eligibleRoles: [], eligibleUsers: [] });
    const out = await writeDenial(err, INPUT, noAccess, KB, gate);
    expect(judge).toHaveBeenCalledWith(expect.any(String), 'alice@example.com', `${KB}/KnowledgeBase/loose.md`, 'file');
    expect(out.details).toMatchObject({
      kind: 'write-denied',
      canPropose: false,
      cannotProposeReason: 'Proposing is not available: you cannot read this path.',
    });
  });

  it('without a gate the read verdict alone decides, as before', async () => {
    const accessControl = { canRead: vi.fn(async () => true) } as unknown as IAccessControl;
    const err = new AccessDeniedError({ path: `${KB}/KnowledgeBase/Sales/deal.md`, eligibleRoles: [], eligibleUsers: [] });
    const out = await writeDenial(err, INPUT, accessControl, KB);
    expect(accessControl.canRead).toHaveBeenCalledWith('target-company-state', 'alice@example.com', 'KnowledgeBase/Sales/deal.md');
    expect(out.details).toMatchObject({ kind: 'write-denied', canPropose: true });
  });

  it('a gate that cannot answer refuses to offer the route', async () => {
    const gate: IChangeReadGate = { judge: vi.fn(async () => { throw new Error('git down'); }), assertMayChange: vi.fn() };
    const err = new AccessDeniedError({ path: `${KB}/KnowledgeBase/Sales/deal.md`, eligibleRoles: [], eligibleUsers: [] });
    const out = await writeDenial(err, INPUT, noAccess, KB, gate);
    expect(out.details).toMatchObject({ canPropose: false });
    expect(out.details?.cannotProposeReason).toContain('could not be determined');
  });
});
