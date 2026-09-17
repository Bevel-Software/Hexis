import { describe, it, expect } from 'vitest';
import { extractFrontmatter as sharedSplit } from '@bevel-software/platform-shared';
import { scanFrontmatter } from '../frontmatter-lines.js';

/**
 * Two frontmatter readers survive in the platform, on purpose:
 *
 *   - the SHARED splitter (`@bevel-software/platform-shared`), used by the
 *     skill catalog, the tool manuals, node ids and the frontmatter panel —
 *     everything that wants the two halves as strings;
 *   - the access model's LINE scan, which has to put bytes back exactly as it
 *     found them and so needs the lines.
 *
 * They do not share an implementation, but they share ONE fence rule
 * (`isFrontmatterFence`: a line that is `---` once whitespace is trimmed).
 * They used not to: the splitter demanded `---` at column 0, so a file with a
 * near-miss fence had access rules that applied while its catalog entry had
 * no id. Every case below is asserted for BOTH readers, so if they ever drift
 * apart again it shows up here, in review, rather than in a customer's
 * knowledge base.
 */

const hasShared = (text: string) => sharedSplit(text) !== null;
const hasLines = (text: string) => scanFrontmatter(text).kind === 'frontmatter';

describe('frontmatter fences: both readers give the same answer', () => {
  it.each([
    ['a plain block', '---\nread:\n  - everyone\n---\nbody\n', true],
    ['no fence at all', 'just a body\n', false],
    ['an unterminated block', '---\nread:\n  - everyone\n', false],
    ['a fence that is not the first line', 'title\n---\nread: x\n---\n', false],
    ['a lone fence and nothing else', '---', false],
    ['an empty block', '---\n---\nbody\n', true],
    // The near-miss fences — forgiving everywhere now.
    ['an opening fence with trailing whitespace', '--- \nread:\n  - everyone\n---\nbody\n', true],
    ['an indented opening fence', '  ---\nread:\n  - everyone\n---\nbody\n', true],
    ['an indented closing fence', '---\nread:\n  - everyone\n  ---\nbody\n', true],
    ['a closing fence with trailing whitespace', '---\nread:\n  - everyone\n--- \nbody\n', true],
    ['a tab-indented fence pair', '\t---\nid: x\n\t---\n', true],
    // Not fences: more dashes, or dashes with words after them.
    ['four dashes is not a fence', '----\nid: x\n----\n', false],
    ['a dashed line with text after it is not a closing fence', '---\nid: x\n--- not a fence\n', false],
  ])('%s → %s for both', (_name, text, expected) => {
    expect(hasShared(text)).toBe(expected);
    expect(hasLines(text)).toBe(expected);
  });
});

describe('the shared splitter hands back both halves byte for byte', () => {
  it('splits a near-miss block into the lines between the fences and the text after', () => {
    expect(sharedSplit('  --- \nid: my-skill\ndescription: Does a thing.\n ---\n# Title\n')).toEqual({
      frontmatter: 'id: my-skill\ndescription: Does a thing.',
      body: '# Title\n',
    });
  });

  it("keeps a CRLF file's own line endings inside the frontmatter and the body", () => {
    expect(sharedSplit('---\r\nid: a\r\nname: b\r\n---\r\nline one\r\nline two')).toEqual({
      frontmatter: 'id: a\r\nname: b',
      body: 'line one\r\nline two',
    });
  });

  it('gives an empty body when the closing fence is the last line', () => {
    expect(sharedSplit('---\nid: a\n---')).toEqual({ frontmatter: 'id: a', body: '' });
  });

  it('gives an empty frontmatter for a block with nothing between its fences', () => {
    expect(sharedSplit('---\n---\nbody')).toEqual({ frontmatter: '', body: 'body' });
  });
});
