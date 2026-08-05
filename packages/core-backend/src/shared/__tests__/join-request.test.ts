import { describe, it, expect } from 'vitest';
import { isJoinBranchFor, joinBranchFor, kebabGroupName } from '@bevel-software/platform-shared';
import { assertValidBranchName } from '../../modules/workflow/git/branch-name.js';

/**
 * The join-branch convention. Two properties matter, and they pull in
 * different directions:
 *
 *  - UNIQUENESS (the write side): distinct requesters and distinct groups must
 *    never share a branch, or one person's commit lands on another's request.
 *    Both inputs the name is built from are lossy, which is what the tag fixes.
 *  - RECOGNISABILITY (the read side): the owner-side banner must spot OTHER
 *    people's join branches without knowing their email, so the predicate
 *    matches the shape, not the tag.
 */
describe('joinBranchFor', () => {
  it('produces a valid branch name that follows the draft convention', () => {
    const branch = joinBranchFor('ali@bevel.software', 'GTM');
    expect(branch).toMatch(/^ali\/join-gtm-[0-9a-z]{7}$/);
    expect(() => assertValidBranchName(branch)).not.toThrow();
  });

  it('is deterministic, and case-insensitive in the email only', () => {
    expect(joinBranchFor('Ali@Bevel.Software', 'GTM')).toBe(joinBranchFor('ali@bevel.software', 'GTM'));
  });

  it('separates requesters who share a localpart across domains', () => {
    // Regression: without the tag both collapse to `ali/join-gtm`, so the
    // second requester's grant commit lands on the first one's branch and
    // merging the FIRST request silently admits BOTH.
    expect(joinBranchFor('ali@bevel.software', 'GTM')).not.toBe(
      joinBranchFor('ali@other.com', 'GTM'),
    );
  });

  it('separates groups whose names kebab to the same slug', () => {
    // `Finance!` and `Finance` both slug to `finance`; without the tag the
    // second request is answered with the first one's change request.
    expect(joinBranchFor('ali@bevel.software', 'Finance!')).not.toBe(
      joinBranchFor('ali@bevel.software', 'Finance'),
    );
    // Case is part of a group's identity (the folder name is case-sensitive).
    expect(joinBranchFor('ali@bevel.software', 'finance')).not.toBe(
      joinBranchFor('ali@bevel.software', 'Finance'),
    );
  });

  it('still yields a valid, matchable branch for a group with no alphanumerics', () => {
    const branch = joinBranchFor('ali@bevel.software', '!!!');
    expect(kebabGroupName('!!!')).toBe('');
    expect(branch).toMatch(/^ali\/join-[0-9a-z]{7}$/);
    expect(() => assertValidBranchName(branch)).not.toThrow();
    expect(isJoinBranchFor(branch, '!!!')).toBe(true);
  });
});

describe('isJoinBranchFor', () => {
  it("recognises somebody ELSE's join branch (the tag is not recomputed)", () => {
    expect(isJoinBranchFor(joinBranchFor('juan@bevel.software', 'GTM'), 'GTM')).toBe(true);
    expect(isJoinBranchFor(joinBranchFor('ali@other.com', 'GTM'), 'GTM')).toBe(true);
  });

  it('rejects a branch for a different group', () => {
    expect(isJoinBranchFor(joinBranchFor('ali@bevel.software', 'Finance'), 'GTM')).toBe(false);
  });

  it('rejects ordinary draft branches and near-misses', () => {
    for (const branch of [
      'ali/gtm',
      'ali/join-gtm', // no tag — the pre-tag shape
      'ali/join-gtm-SHOUTY', // tag is lowercase base36
      'ali/join-gtm-abc', // wrong tag length
      'ali/join-gtm-abc1234/extra',
      'join-gtm-abc1234', // no author segment
    ]) {
      expect(isJoinBranchFor(branch, 'GTM'), branch).toBe(false);
    }
  });
});
