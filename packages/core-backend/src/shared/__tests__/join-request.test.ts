import { describe, it, expect } from 'vitest';
import { isJoinBranchFor, joinBranchFor, kebabPluginName } from '@bevel-software/platform-shared';
import { assertValidBranchName } from '../../modules/kb-fs/branch-name.js';

/**
 * The join-branch convention. Two properties matter, and they pull in
 * different directions:
 *
 *  - UNIQUENESS (the write side): distinct requesters and distinct plugins must
 *    never share a branch, or one person's commit lands on another's request.
 *    Both inputs the name is built from are lossy; the requester tag fixes it.
 *  - EXACT PLUGIN IDENTITY (the read side): the settle decision is "the diff
 *    is empty", so matching a branch to the WRONG plugin reads an unchanged
 *    file, sees an empty diff, and destroys somebody else's request. The
 *    plugin tag is recomputed from the exact name so shape-matching can never
 *    cross plugins; only the requester half matches by shape (the reader has
 *    no email to recompute it from).
 */
const TAG = '[0-9a-z]{7}';

describe('joinBranchFor', () => {
  it('produces a valid branch name that follows the draft convention', () => {
    const branch = joinBranchFor('ali@bevel.software', 'GTM');
    expect(branch).toMatch(new RegExp(`^ali/join-gtm-${TAG}-${TAG}$`));
    expect(() => assertValidBranchName(branch)).not.toThrow();
  });

  it('is deterministic, and case-insensitive in the email only', () => {
    expect(joinBranchFor('Ali@Bevel.Software', 'GTM')).toBe(joinBranchFor('ali@bevel.software', 'GTM'));
  });

  it('separates requesters who share a localpart across domains', () => {
    // Regression: without the requester tag both collapse to one branch, so
    // the second requester's grant commit lands on the first one's branch.
    expect(joinBranchFor('ali@bevel.software', 'GTM')).not.toBe(
      joinBranchFor('ali@other.com', 'GTM'),
    );
  });

  it('separates plugins whose names kebab to the same slug', () => {
    expect(joinBranchFor('ali@bevel.software', 'Finance!')).not.toBe(
      joinBranchFor('ali@bevel.software', 'Finance'),
    );
    // Case is part of a plugin's identity (the folder name is case-sensitive).
    expect(joinBranchFor('ali@bevel.software', 'finance')).not.toBe(
      joinBranchFor('ali@bevel.software', 'Finance'),
    );
  });

  it('still yields a valid, matchable branch for a plugin with no alphanumerics', () => {
    const branch = joinBranchFor('ali@bevel.software', '!!!');
    expect(kebabPluginName('!!!')).toBe('');
    expect(branch).toMatch(new RegExp(`^ali/join-${TAG}-${TAG}$`));
    expect(() => assertValidBranchName(branch)).not.toThrow();
    expect(isJoinBranchFor(branch, '!!!')).toBe(true);
  });
});

describe('isJoinBranchFor', () => {
  it("recognises somebody ELSE's join branch (the requester tag is not recomputed)", () => {
    expect(isJoinBranchFor(joinBranchFor('juan@bevel.software', 'GTM'), 'GTM')).toBe(true);
    expect(isJoinBranchFor(joinBranchFor('ali@other.com', 'GTM'), 'GTM')).toBe(true);
  });

  it('rejects a branch for a different plugin', () => {
    expect(isJoinBranchFor(joinBranchFor('ali@bevel.software', 'Finance'), 'GTM')).toBe(false);
  });

  it('NEVER crosses slug-colliding plugins — the destructive-settle regression', () => {
    // `Finance!`, `finance` and `Finance` all slug to `finance`. A listing
    // for one that matched another's branch would read that branch's copy of
    // ITS OWN access.md (unchanged there), see an empty diff, and settle —
    // closing a change request and deleting a branch belonging to a
    // different plugin. The recomputed plugin tag is what forbids the match.
    const forBang = joinBranchFor('ali@bevel.software', 'Finance!');
    expect(isJoinBranchFor(forBang, 'finance')).toBe(false);
    expect(isJoinBranchFor(forBang, 'Finance')).toBe(false);
    expect(isJoinBranchFor(forBang, 'Finance!')).toBe(true);
    expect(isJoinBranchFor(joinBranchFor('ali@bevel.software', 'finance'), 'Finance!')).toBe(false);
  });

  it('rejects ordinary draft branches and near-misses', () => {
    const good = joinBranchFor('ali@bevel.software', 'GTM');
    const [, suffix] = good.split('/');
    for (const branch of [
      'ali/gtm',
      'ali/join-gtm', // no tags — the pre-tag shape
      'ali/join-gtm-abc1234', // one tag only
      `ali/${suffix.toUpperCase()}`, // tags are lowercase base36
      `ali/${suffix}/extra`,
      suffix, // no author segment
    ]) {
      expect(isJoinBranchFor(branch, 'GTM'), branch).toBe(false);
    }
  });
});
