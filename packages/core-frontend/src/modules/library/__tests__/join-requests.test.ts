import { describe, it, expect } from 'vitest';
import { joinBranchFor, type ChangeRequest } from '@bevel-software/platform-shared';
import { joinRequestsFor } from '../utils/join-requests';

/**
 * What the owner-side banner is willing to call a join request.
 *
 * The banner puts an Approve button that MERGES a change request above the
 * words "asked to join", so the guard here is not cosmetic: draft branches are
 * ungated, so anyone can push anything to a branch that matches the naming
 * convention. Only a diff that is exactly the promised grant earns the friendly
 * treatment.
 */
const ALI = 'ali@bevel.software';

function cr(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    number: 7,
    title: 'Join request: GTM',
    author: { login: 'user-abc' },
    appAuthor: { name: 'Ali Baba' },
    branch: joinBranchFor(ALI, 'GTM'),
    base: 'main',
    state: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    touchedNodePaths: ['Groups/GTM/access.md'],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: '/change-requests/7',
    ...over,
  } as ChangeRequest;
}

describe('joinRequestsFor', () => {
  it('accepts an open join branch that touches exactly the group access.md', () => {
    expect(joinRequestsFor([cr()], 'GTM')).toEqual([{ number: 7, requesterName: 'Ali Baba' }]);
  });

  it('falls back to a neutral name when the change request has no app author', () => {
    expect(joinRequestsFor([cr({ appAuthor: undefined })], 'GTM')[0].requesterName).toBe('Someone');
  });

  it.each([
    ['a merged/closed request', { state: 'closed' as const }],
    ['a branch outside the convention', { branch: 'ali/some-draft' }],
    ['a join branch for another group', { branch: joinBranchFor(ALI, 'Finance') }],
  ])('rejects %s', (_label, over) => {
    expect(joinRequestsFor([cr(over)], 'GTM')).toEqual([]);
  });

  it.each([
    ['EXTRA files beyond the grant', ['Groups/GTM/access.md', 'Groups/GTM/outreach/SKILL.md']],
    ['an unrelated file only', ['Groups/GTM/outreach/SKILL.md']],
    ['another group access.md', ['Groups/Finance/access.md']],
    ['the root access.md', ['access.md']],
    ['nothing computed', []],
  ])('rejects a correctly-named branch touching %s', (_label, touchedNodePaths) => {
    // The name says "join request"; the diff is what decides. An uncomputed
    // path list is skipped rather than assumed benign — fail-closed.
    expect(joinRequestsFor([cr({ touchedNodePaths })], 'GTM')).toEqual([]);
  });
});
