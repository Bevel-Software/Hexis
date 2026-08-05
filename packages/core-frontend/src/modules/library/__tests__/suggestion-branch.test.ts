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
  it('names the file, so one skill can hold several open proposals', () => {
    const a = suggestionBranchFor('juan@bevel.software', 'newsletter', 'SKILL.md');
    const b = suggestionBranchFor('juan@bevel.software', 'newsletter', 'sources.yaml');

    expect(a).toBe('suggestions/juan/newsletter--skill.md');
    expect(b).toBe('suggestions/juan/newsletter--sources.yaml');
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

    expect(b).toBe('suggestions/juan/deck--reference-design-system.md');
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
    expect(lock).toBe('suggestions/juan/deck--deps-lock');
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
