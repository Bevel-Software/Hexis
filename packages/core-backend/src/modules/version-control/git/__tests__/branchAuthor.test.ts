import { describe, it, expect } from 'vitest';
import {
  branchAuthorLocalpart,
  isBranchAuthoredBy,
  isOwnBranch,
  isOwnSuggestionsBranch,
  ownDraftPrefixFor,
} from '@bevel-software/platform-shared';

describe('branchAuthorLocalpart', () => {
  it('extracts and lowercases the localpart', () => {
    expect(branchAuthorLocalpart('Alice@example.com')).toBe('alice');
  });

  it('sanitizes dotted localparts to match slugifyDraftName', () => {
    // The frontend slugifies "john.doe" → "john-doe" when creating drafts,
    // so authorship has to recognise the same shape on lookup.
    expect(branchAuthorLocalpart('john.doe@example.com')).toBe('john-doe');
  });

  it('sanitizes plus-addressed localparts the same way', () => {
    expect(branchAuthorLocalpart('alice+test@example.com')).toBe('alice-test');
  });

  it('returns null for empty / missing email', () => {
    expect(branchAuthorLocalpart('')).toBeNull();
    expect(branchAuthorLocalpart(null)).toBeNull();
    expect(branchAuthorLocalpart(undefined)).toBeNull();
  });

  it('returns null when the localpart sanitizes to a prefix no branch name can start with', () => {
    // `_ops` sanitizes to `-ops`, and `-ops/fix` is no branch name: nothing
    // could ever be theirs by that prefix, so it is no identity.
    expect(branchAuthorLocalpart('_ops@example.com')).toBeNull();
    expect(branchAuthorLocalpart('+team@example.com')).toBeNull();
    expect(isBranchAuthoredBy('-ops/fix', '_ops@example.com')).toBe(false);
    // A dash further in is an ordinary prefix.
    expect(branchAuthorLocalpart('ops_@example.com')).toBe('ops-');
  });

  it('returns null when the localpart sanitizes to nothing (no auth identity)', () => {
    // Email with only non-alphanumeric chars before @ — refuse to derive an
    // identity rather than silently mapping to a default like "user", which
    // would let any malformed-email user delete any "user/..." branch.
    expect(branchAuthorLocalpart('___@example.com')).toBeNull();
  });

  it('handles emails with no @ by treating the whole string as localpart', () => {
    // Internal identity systems occasionally use bare usernames; sanitizing
    // them through the same pipeline keeps the comparison consistent.
    expect(branchAuthorLocalpart('alice')).toBe('alice');
  });
});

describe('isBranchAuthoredBy', () => {
  it('matches when the branch name starts with <localpart>/', () => {
    expect(isBranchAuthoredBy('alice/my-draft', 'alice@example.com')).toBe(true);
  });

  it('rejects when prefix is a different user', () => {
    expect(isBranchAuthoredBy('bob/my-draft', 'alice@example.com')).toBe(false);
  });

  it('rejects when the branch has no slash (no recognisable prefix)', () => {
    expect(isBranchAuthoredBy('alice', 'alice@example.com')).toBe(false);
  });

  it('rejects conventional non-author prefixes (fix/, polish/)', () => {
    // `fix/...` is a common CLI-created prefix in this repo. It has no author
    // claim, so the authored-by check must NOT grant ownership to anyone.
    expect(isBranchAuthoredBy('fix/some-bug', 'alice@example.com')).toBe(false);
    expect(isBranchAuthoredBy('polish/foo', 'alice@example.com')).toBe(false);
  });

  it('returns false when email is null / undefined / empty', () => {
    expect(isBranchAuthoredBy('alice/my-draft', null)).toBe(false);
    expect(isBranchAuthoredBy('alice/my-draft', undefined)).toBe(false);
    expect(isBranchAuthoredBy('alice/my-draft', '')).toBe(false);
  });

  it('matches case-insensitively on the email side (branch is already lowercase by convention)', () => {
    // slugifyDraftName lowercases the email at create time, so a user with
    // capitals in their email still ends up owning a lowercase prefix.
    expect(isBranchAuthoredBy('alice/draft', 'ALICE@example.com')).toBe(true);
  });

  it('requires the slash boundary — does not treat substring as prefix', () => {
    // "alice-extra/foo" must not look authored by "alice" — otherwise users
    // could delete other people's branches whose prefix happens to start
    // with their own localpart.
    expect(isBranchAuthoredBy('alice-extra/foo', 'alice@example.com')).toBe(false);
  });
});

describe('ownDraftPrefixFor', () => {
  it('is the localpart prefix authorship recognises', () => {
    const user = { id: 'u-1', email: 'John.Doe@example.com' };
    expect(ownDraftPrefixFor(user)).toBe('john-doe/');
    expect(isBranchAuthoredBy(`${ownDraftPrefixFor(user)}fix`, user.email)).toBe(true);
  });

  it('falls back to the suggestions prefix for an address with no usable localpart, still theirs', () => {
    const user = { id: 'abcdef123456', email: '---@example.com' };
    expect(ownDraftPrefixFor(user)).toBe('suggestions/user-abcdef12/');
    expect(isOwnSuggestionsBranch(`${ownDraftPrefixFor(user)}fix`, user)).toBe(true);
  });

  it('falls back the same way for a localpart no branch name can start with', () => {
    const user = { id: 'abcdef123456', email: '_ops@example.com' };
    expect(ownDraftPrefixFor(user)).toBe('suggestions/_ops-abcdef12/');
    expect(isOwnBranch(`${ownDraftPrefixFor(user)}fix`, user)).toBe(true);
  });

  it("is not another person's: the id slice tells two people with the same localpart apart", () => {
    const mine = { id: 'abcdef123456', email: '---@example.com' };
    const theirs = { id: 'zyxwvu987654', email: '---@example.com' };
    expect(isOwnBranch(`${ownDraftPrefixFor(mine)}fix`, theirs)).toBe(false);
    expect(isOwnSuggestionsBranch(`${ownDraftPrefixFor(mine)}fix`, theirs)).toBe(false);
  });
});
