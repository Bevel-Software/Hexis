import { describe, it, expect } from 'vitest';
import { extractFrontmatter as sharedSplit } from '@bevel-software/platform-shared';
import { scanFrontmatter } from '../frontmatter-lines.js';

/**
 * Two frontmatter readers survive in the platform, on purpose:
 *
 *   - the SHARED regex splitter (`@bevel-software/platform-shared`), used by
 *     the skill catalog, the tool manuals, node ids and the frontmatter panel
 *     — everything that wants the two halves as strings;
 *   - this LINE-based scan, used by the access model, which has to put bytes
 *     back exactly as it found them and so needs the lines.
 *
 * They do not have to share an implementation. They DO have to be understood,
 * because they answer "does this file have frontmatter at all?" — and where
 * they disagree, a file's access rules apply while its catalog entry has no
 * id, or the reverse.
 *
 * This test is the record of that. Every case below is asserted for BOTH, so
 * a change to either shows up here as a diff rather than in a customer's
 * knowledge base.
 */

const hasShared = (text: string) => sharedSplit(text) !== null;
const hasLines = (text: string) => scanFrontmatter(text).kind === 'frontmatter';

describe('frontmatter fences: where the two readers agree', () => {
  it.each([
    ['a plain block', '---\nread:\n  - everyone\n---\nbody\n', true],
    ['no fence at all', 'just a body\n', false],
    ['an unterminated block', '---\nread:\n  - everyone\n', false],
    ['a fence that is not the first line', 'title\n---\nread: x\n---\n', false],
  ])('%s → %s for both', (_name, text, expected) => {
    expect(hasShared(text)).toBe(expected);
    expect(hasLines(text)).toBe(expected);
  });
});

describe('frontmatter fences: where they DISAGREE — known, and deliberate', () => {
  it('an opening fence with trailing whitespace: rules apply, the catalog sees nothing', () => {
    const text = '--- \nread:\n  - everyone\n---\nbody\n';
    expect(hasLines(text)).toBe(true); // the access model reads the rules
    expect(hasShared(text)).toBe(false); // the catalog sees a file with no frontmatter
  });

  it('an INDENTED OPENING fence: same split', () => {
    // The shared regex is `^---\r?\n…` with no `m` flag, so `^` is the start
    // of the STRING and the fence must sit at column 0. The line rule trims.
    const text = '  ---\nread:\n  - everyone\n---\nbody\n';
    expect(hasLines(text)).toBe(true);
    expect(hasShared(text)).toBe(false);
  });

  it('an indented closing fence: same split', () => {
    const text = '---\nread:\n  - everyone\n  ---\nbody\n';
    expect(hasLines(text)).toBe(true);
    expect(hasShared(text)).toBe(false);
  });

  it('a trailing-spaced CLOSING fence is not a disagreement — both accept it', () => {
    // The regex's closing `\r?\n?` is optional, so `--- ` still matches; only
    // the body it reports differs. Recorded so the list above stays honest
    // about which cases are actually the risky ones.
    const text = '---\nread:\n  - everyone\n--- \nbody\n';
    expect(hasShared(text)).toBe(true);
    expect(hasLines(text)).toBe(true);
  });
});
