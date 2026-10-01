import { describe, it, expect } from 'vitest';
import { computeViewerCanDelete } from '../pull-request.service.js';
import { hashEmail } from '../../../../shared/email-identity.js';

const EMAIL = 'juan@bevel.software';
const AUTHOR_HASH = hashEmail(EMAIL);
const OTHER_AUTHOR_HASH = hashEmail('someone-else@bevel.software');

/**
 * The truth table for who may delete a request outright — close it AND retire
 * its branch. It must mirror `deleteChangeRequest`'s own check, which is why
 * the interesting rows here are the ones where it DIFFERS from its siblings:
 * an owner of every changed file is absent (they decline, they do not
 * destroy), and a closed request still says yes (its leftover branch is still
 * the server's to retire).
 */
describe('computeViewerCanDelete', () => {
  it('lets the author delete their own open request', () => {
    expect(
      computeViewerCanDelete({
        state: 'open',
        authorId: AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
      }),
    ).toBe(true);
  });

  it('lets an admin delete someone else’s open request', () => {
    expect(
      computeViewerCanDelete({
        state: 'open',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: true,
      }),
    ).toBe(true);
  });

  it('says yes once for a viewer who is both author and admin', () => {
    expect(
      computeViewerCanDelete({
        state: 'open',
        authorId: AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: true,
      }),
    ).toBe(true);
  });

  it('refuses a signed-in user who is neither author nor admin', () => {
    expect(
      computeViewerCanDelete({
        state: 'open',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
      }),
    ).toBe(false);
  });

  it('fails closed with no viewer, even on one’s own-looking request', () => {
    expect(
      computeViewerCanDelete({
        state: 'open',
        authorId: AUTHOR_HASH,
        viewerEmail: undefined,
        viewerCanBypassMerge: false,
      }),
    ).toBe(false);
  });

  it('fails closed for an anonymous admin-flagged read', () => {
    expect(
      computeViewerCanDelete({
        state: 'open',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: undefined,
        viewerCanBypassMerge: true,
      }),
    ).toBe(false);
  });

  it('refuses an APPLIED request to its author — applied history is nobody’s to delete', () => {
    expect(
      computeViewerCanDelete({
        state: 'merged',
        authorId: AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
      }),
    ).toBe(false);
  });

  it('refuses an APPLIED request to an admin too', () => {
    expect(
      computeViewerCanDelete({
        state: 'merged',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: true,
      }),
    ).toBe(false);
  });

  it('still says yes on a CLOSED request: the leftover branch is the delete’s job', () => {
    // Withdrawn in another tab. The server's delete still succeeds there and
    // removes the branch the withdraw left behind, so the hint must not go
    // quiet the moment the row flips — unlike `viewerCanCancel`, which is
    // open-only because there is nothing left to cancel.
    expect(
      computeViewerCanDelete({
        state: 'closed',
        authorId: AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
      }),
    ).toBe(true);
    expect(
      computeViewerCanDelete({
        state: 'closed',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: true,
      }),
    ).toBe(true);
  });

  it('refuses a request with no stored author to a non-admin (opened outside this backend)', () => {
    expect(
      computeViewerCanDelete({
        state: 'open',
        authorId: undefined,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
      }),
    ).toBe(false);
  });

  it('leaves normalization to hashEmail, exactly as its siblings do', () => {
    expect(
      computeViewerCanDelete({
        state: 'open',
        authorId: AUTHOR_HASH,
        viewerEmail: '  Juan@Bevel.Software  ',
        viewerCanBypassMerge: false,
      }),
    ).toBe(true);
  });

  it('does NOT grant the owner of every changed file — it takes no such input', () => {
    // Decision 4. The owner of every changed file is exactly the person
    // `computeViewerCanCancel` says yes to and this predicate must not: they
    // may decline the request, which leaves the author's branch to rework.
    // There is no input here to express that grant, and the row a
    // file-owning non-admin produces reads false.
    expect(
      computeViewerCanDelete({
        state: 'open',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
      }),
    ).toBe(false);
  });
});
