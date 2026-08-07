import { describe, it, expect } from 'vitest';
import { computeViewerCanCancel } from '../pull-request.service.js';
import { hashEmail } from '../../../../shared/hash-email.js';

const EMAIL = 'juan@bevel.software';
const AUTHOR_HASH = hashEmail(EMAIL);
const OTHER_AUTHOR_HASH = hashEmail('someone-else@bevel.software');

describe('computeViewerCanCancel', () => {
  it('returns false when viewerEmail is missing (anonymous detail fetch)', () => {
    expect(
      computeViewerCanCancel({
        state: 'open',
        authorId: AUTHOR_HASH,
        viewerEmail: undefined,
        viewerCanBypassMerge: false,
        viewerWritesAllFiles: false,
      }),
    ).toBe(false);
  });

  it('returns true when state is open and the viewer is the author', () => {
    expect(
      computeViewerCanCancel({
        state: 'open',
        authorId: AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
        viewerWritesAllFiles: false,
      }),
    ).toBe(true);
  });

  it('returns true when state is open and the viewer is an admin (bypass=true)', () => {
    expect(
      computeViewerCanCancel({
        state: 'open',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: true,
        viewerWritesAllFiles: false,
      }),
    ).toBe(true);
  });

  it('returns true when viewer is both author AND admin', () => {
    expect(
      computeViewerCanCancel({
        state: 'open',
        authorId: AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: true,
        viewerWritesAllFiles: false,
      }),
    ).toBe(true);
  });

  it('returns false when state is closed even for the author', () => {
    expect(
      computeViewerCanCancel({
        state: 'closed',
        authorId: AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
        viewerWritesAllFiles: false,
      }),
    ).toBe(false);
  });

  it('returns false when state is merged even for an admin', () => {
    expect(
      computeViewerCanCancel({
        state: 'merged',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: true,
        viewerWritesAllFiles: false,
      }),
    ).toBe(false);
  });

  it('returns false when authorId is absent and the viewer is not an admin (PRs opened outside bevel)', () => {
    expect(
      computeViewerCanCancel({
        state: 'open',
        authorId: undefined,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
        viewerWritesAllFiles: false,
      }),
    ).toBe(false);
  });

  it('normalizes the viewer email exactly the same way hashEmail does (trim + lowercase)', () => {
    // hashEmail trims + lowercases internally; the predicate must hash the
    // raw viewerEmail it gets and rely on hashEmail's normalization. A
    // regression where the predicate pre-normalizes or skips normalization
    // would break attribution for any caller that doesn't already normalize.
    expect(
      computeViewerCanCancel({
        state: 'open',
        authorId: AUTHOR_HASH,
        viewerEmail: '  Juan@Bevel.Software  ',
        viewerCanBypassMerge: false,
        viewerWritesAllFiles: false,
      }),
    ).toBe(true);
  });

  it('returns true for a non-author, non-admin who writes EVERY changed file (the reject route’s third grant)', () => {
    expect(
      computeViewerCanCancel({
        state: 'open',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
        viewerWritesAllFiles: true,
      }),
    ).toBe(true);
  });

  it('fails closed for an anonymous viewer even with the owner grant', () => {
    expect(
      computeViewerCanCancel({
        state: 'open',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: undefined,
        viewerCanBypassMerge: false,
        viewerWritesAllFiles: true,
      }),
    ).toBe(false);
  });

  it('terminal states refuse the owner grant too', () => {
    expect(
      computeViewerCanCancel({
        state: 'merged',
        authorId: OTHER_AUTHOR_HASH,
        viewerEmail: EMAIL,
        viewerCanBypassMerge: false,
        viewerWritesAllFiles: true,
      }),
    ).toBe(false);
  });
});
