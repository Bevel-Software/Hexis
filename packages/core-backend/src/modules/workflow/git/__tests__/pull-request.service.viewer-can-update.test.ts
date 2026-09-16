import { describe, it, expect } from 'vitest';
import type { FileApprovalState } from '@bevel-software/platform-shared';
import { computeViewerCanUpdate } from '../pull-request.service.js';
import { hashEmail } from '../../../../shared/email-identity.js';

/**
 * Update (merge the target into a request's branch) belongs to the request's
 * author and to anyone who may apply it. Everyone else sees the "has changed"
 * notice without the button — and the route refuses them the same way.
 */

const EMAIL = 'juan@bevel.software';
const AUTHOR = hashEmail(EMAIL);
const SOMEONE_ELSE = hashEmail('someone-else@bevel.software');

const file = (
  isApproved: boolean,
  viewerCanApprove: boolean,
  path = 'Sales/Deal.md',
  owned = true,
  eligibilityResolved = true,
) =>
  ({
    path,
    isApproved,
    viewerCanApprove,
    eligibilityResolved,
    eligibleApprovers: { roles: owned ? ['Sales'] : [], users: [] },
    approvedBy: [],
  }) as FileApprovalState;

const base = {
  state: 'open' as const,
  authorId: SOMEONE_ELSE,
  viewerEmail: EMAIL,
  viewerCanBypassMerge: false,
  approvals: [file(false, false)],
};

describe('computeViewerCanUpdate', () => {
  it('the author may update', () => {
    expect(computeViewerCanUpdate({ ...base, authorId: AUTHOR })).toBe(true);
  });

  it('a viewer who may apply (every file approved or approvable by them) may update', () => {
    expect(
      computeViewerCanUpdate({ ...base, approvals: [file(true, false), file(false, true)] }),
    ).toBe(true);
  });

  it('files outside the approval gate withhold nothing — they need no approval to apply', () => {
    // A non-Markdown file and an ownerless note: the merge gate lets anyone
    // apply these, so anyone may update them too.
    expect(
      computeViewerCanUpdate({
        ...base,
        approvals: [file(false, false, 'Sales/deal.yaml'), file(false, false, 'Notes/Loose.md', false)],
      }),
    ).toBe(true);
    // One gate-bound file the viewer cannot approve still refuses.
    expect(
      computeViewerCanUpdate({ ...base, approvals: [file(false, false, 'Sales/deal.yaml'), file(false, false)] }),
    ).toBe(false);
    // roles.yaml is bound by the gate even though it is not Markdown.
    expect(computeViewerCanUpdate({ ...base, approvals: [file(false, false, 'roles.yaml')] })).toBe(false);
  });

  it('an unresolved access tree fails closed — empty approvers are unknown, not outside the gate', () => {
    // No workspace or a failed lookup: every file comes back with no eligible
    // approvers, which must not read as "nobody needs to approve".
    expect(
      computeViewerCanUpdate({
        ...base,
        approvals: [file(false, false, 'Sales/deal.yaml', false, false), file(false, false, 'Notes/Loose.md', false, false)],
      }),
    ).toBe(false);
    // A detail built without the flag at all is treated the same way.
    const legacy = { ...file(false, false, 'Notes/Loose.md', false) } as Partial<FileApprovalState>;
    delete legacy.eligibilityResolved;
    expect(computeViewerCanUpdate({ ...base, approvals: [legacy as FileApprovalState] })).toBe(false);
    // The author and an admin are unaffected.
    expect(
      computeViewerCanUpdate({ ...base, authorId: AUTHOR, approvals: [file(false, false, 'Notes/Loose.md', false, false)] }),
    ).toBe(true);
  });

  it('an admin, who may apply over missing approvals, may update', () => {
    expect(computeViewerCanUpdate({ ...base, viewerCanBypassMerge: true })).toBe(true);
  });

  it('anyone else may not — one file they cannot approve is enough to refuse', () => {
    expect(computeViewerCanUpdate(base)).toBe(false);
    expect(
      computeViewerCanUpdate({ ...base, approvals: [file(false, true), file(false, false)] }),
    ).toBe(false);
    // No files to judge by is not a grant.
    expect(computeViewerCanUpdate({ ...base, approvals: [] })).toBe(false);
  });

  it('fails closed with no viewer, and for a request that is not open', () => {
    expect(computeViewerCanUpdate({ ...base, authorId: AUTHOR, viewerEmail: undefined })).toBe(false);
    expect(computeViewerCanUpdate({ ...base, authorId: AUTHOR, state: 'merged' })).toBe(false);
    expect(computeViewerCanUpdate({ ...base, authorId: AUTHOR, state: 'closed' })).toBe(false);
  });
});
