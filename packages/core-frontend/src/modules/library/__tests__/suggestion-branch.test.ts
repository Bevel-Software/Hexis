import { describe, it, expect } from 'vitest';
import { suggestionBranchFor } from '../services/library.api';

/**
 * The branch name is the ONLY thing tying a proposal to the file it is about,
 * and the backend refuses to create a branch whose name breaks git's ref rules
 * (`assertValidBranchName` in core-backend's `git/branch-name.ts`). A name that
 * trips one of those rules surfaces as a bare 400 on "Propose changes" with
 * nothing on screen saying why — so the rules are asserted here rather than
 * discovered in production.
 *
 * These mirror the backend's checks. They are duplicated rather than imported
 * because core-frontend does not depend on core-backend; if that validator
 * gains a rule, this file is the place that has to learn it too.
 */
const startsLegal = (b: string) => /^[A-Za-z0-9]/.test(b);
const legalChars = (b: string) => /^[A-Za-z0-9][A-Za-z0-9/_\-.]*$/.test(b);

function assertGitAccepts(branch: string) {
  expect(startsLegal(branch)).toBe(true);
  expect(legalChars(branch)).toBe(true);
  expect(branch).not.toContain('..');
  expect(branch).not.toContain('//');
  expect(branch).not.toContain('@{');
  expect(branch.endsWith('/') || branch.endsWith('.')).toBe(false);
  expect(branch.length).toBeLessThanOrEqual(255);
  for (const segment of branch.split('/')) {
    expect(segment.startsWith('.')).toBe(false);
    expect(segment.endsWith('.lock')).toBe(false);
  }
}

describe('suggestionBranchFor', () => {
  /**
   * The exact strings are pinned, not just their shape. `SkillPage` decides
   * which open request belongs to the file on screen by RECOMPUTING this name
   * and comparing it to the request's branch, so the output is a stored
   * contract: change how it is built and every request already open stops
   * being recognised as its author's own.
   */
  it('names the file, so one skill can hold several open proposals', () => {
    const a = suggestionBranchFor('juan@bevel.software', 'newsletter', 'SKILL.md');
    const b = suggestionBranchFor('juan@bevel.software', 'newsletter', 'sources.yaml');

    expect(a).toBe('suggestions/juan/newsletter--skill.md-8124a561');
    expect(b).toBe('suggestions/juan/newsletter--sources.yaml-346aab36');
    // Different files, different branches — this is the whole fix.
    expect(a).not.toBe(b);
  });

  /**
   * FLATTENED with `--`, never nested with `/`. A leftover skill-level branch
   * from before files were in the name is a ref FILE at
   * `refs/heads/suggestions/juan/newsletter`; nesting would ask git to make
   * that same path a directory, and it refuses (D/F conflict) — every propose
   * on the skill would fail for as long as the old branch existed.
   */
  it('keeps the file a sibling of the legacy skill branch, not a child of it', () => {
    const legacy = suggestionBranchFor('juan@bevel.software', 'newsletter');
    const file = suggestionBranchFor('juan@bevel.software', 'newsletter', 'SKILL.md');

    expect(legacy).toBe('suggestions/juan/newsletter');
    expect(file.startsWith(`${legacy}/`)).toBe(false);
    expect(file.startsWith(`${legacy}--`)).toBe(true);
    // Same parent directory ⇒ both can exist at once.
    expect(file.split('/').length).toBe(legacy.split('/').length);
  });

  it('flattens a nested file path into the one segment', () => {
    const b = suggestionBranchFor('juan@bevel.software', 'deck', 'reference/DESIGN-SYSTEM.md');

    expect(b).toBe('suggestions/juan/deck--reference-design-system.md-692a31cc');
    assertGitAccepts(b);
  });

  /**
   * Flattening is LOSSY: '/' and every other character git will not take both
   * become '-', so a nested path and a hyphenated one at the skill root reduce
   * to the same readable slug. That is only a naming curiosity until you
   * remember `SkillPage` matches a request to a file by branch — one branch
   * for two files means the first file's pending request is served to the
   * second as its own, the editor stays shut, and a proposal on the second is
   * written into the first's request rather than opening its own. The digest
   * is taken from the path BEFORE flattening, which is what keeps them apart.
   */
  it('does not collide two files that flatten to the same slug', () => {
    const nested = suggestionBranchFor('juan@bevel.software', 'deck', 'reference/DESIGN-SYSTEM.md');
    const flat = suggestionBranchFor('juan@bevel.software', 'deck', 'reference-design-system.md');

    expect(nested).not.toBe(flat);
    // Same readable slug — only the digest separates them, which is the point.
    expect(nested.startsWith('suggestions/juan/deck--reference-design-system.md-')).toBe(true);
    expect(flat.startsWith('suggestions/juan/deck--reference-design-system.md-')).toBe(true);
    assertGitAccepts(nested);
    assertGitAccepts(flat);
  });

  /**
   * 255 is git's hard ceiling on a ref, and nothing upstream bounds a file
   * path, so the slug is truncated to the room the base leaves. The digest
   * survives the truncation — it is appended after it — so two long paths
   * sharing a truncated prefix still get their own branches.
   */
  it('bounds an overlong nested path to a ref git will accept', () => {
    const deep = `${'deeply/nested/'.repeat(40)}notes.md`;
    const b = suggestionBranchFor('juan@bevel.software', 'deck', deep);

    expect(b.length).toBeLessThanOrEqual(255);
    assertGitAccepts(b);

    // Truncation must not merge two distinct paths that share a long prefix.
    const sibling = suggestionBranchFor('juan@bevel.software', 'deck', `${deep}x`);
    expect(sibling.length).toBeLessThanOrEqual(255);
    expect(sibling).not.toBe(b);
    assertGitAccepts(sibling);
  });

  /** A skill name long enough to crowd out the file still yields a legal ref. */
  it('bounds the ref even when the base itself is pathological', () => {
    const b = suggestionBranchFor('juan@bevel.software', 'x'.repeat(400), 'SKILL.md');

    expect(b.length).toBeLessThanOrEqual(255);
    assertGitAccepts(b);
  });

  /**
   * The dot rules. Both reject the WHOLE branch backend-side, and both only
   * became reachable when file names started feeding the branch — dots are
   * rare in skill names and universal in filenames.
   */
  it('survives file names git would otherwise reject', () => {
    // `..` is invalid anywhere in a ref.
    const dots = suggestionBranchFor('juan@bevel.software', 'deck', 'notes..md');
    expect(dots).not.toContain('..');
    assertGitAccepts(dots);

    // A segment may not end `.lock` — that is how git names its own lockfiles.
    const lock = suggestionBranchFor('juan@bevel.software', 'deck', 'deps.lock');
    expect(lock.endsWith('.lock')).toBe(false);
    expect(lock).toBe('suggestions/juan/deck--deps-lock-5647bf0c');
    assertGitAccepts(lock);
  });

  it('produces a legal branch for the punctuation a real skill folder carries', () => {
    for (const file of [
      'SKILL.md',
      'scripts/export-pdf.py',
      'scripts/video-to-gif.sh',
      'template/deck.html',
      'reference/QA-STANDARDS.md',
      '.gitignore',
      'weird name (v2).md',
      'ünïcode.md',
    ]) {
      assertGitAccepts(suggestionBranchFor('Juan.Viera@bevel.software', 'create-reading-deck', file));
    }
  });
});
