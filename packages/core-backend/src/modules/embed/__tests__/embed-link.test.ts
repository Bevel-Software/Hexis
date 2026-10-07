import { describe, expect, it } from 'vitest';
import {
  EmbedRefParseError,
  isSafeRepoRelativeEmbedPath,
  parseEmbedRef,
} from '../embed-link.js';

const KB = 'knowledge-base';

/**
 * The mint's reference grammar — the boundary between Hexis and the Atlassian
 * connector's own repository, which is why its shape may not change. Two
 * consumers hand it very different strings: `open_page` a path from a model,
 * the connector a `content:` marker a person pasted into a ticket.
 */
describe('parseEmbedRef', () => {
  it.each([
    ['a bare path', 'Data/Thing.md', { repoRelative: 'Data/Thing.md' }],
    ['a path under the kb folder', `${KB}/Data/Thing.md`, { repoRelative: 'Data/Thing.md' }],
    ['a leading slash', '/Data/Thing.md', { repoRelative: 'Data/Thing.md' }],
    ['a dot-slash', './Data/Thing.md', { repoRelative: 'Data/Thing.md' }],
    [
      'a heading anchor',
      'Data/Thing.md#problem-statement',
      { repoRelative: 'Data/Thing.md', slug: 'problem-statement' },
    ],
    [
      'an app URL',
      `https://hexis.example/workspace/main/${KB}/Data/Thing.md#goal`,
      { repoRelative: 'Data/Thing.md', slug: 'goal' },
    ],
    [
      'an embed URL (the branch segment is ignored)',
      `https://hexis.example/embed/some-draft/${KB}/Data/Thing.md`,
      { repoRelative: 'Data/Thing.md' },
    ],
    ['a content: marker in angle brackets', '<content: Data/Thing.md>', { repoRelative: 'Data/Thing.md' }],
    ['a percent-encoded space', 'Data/Some%20Thing.md', { repoRelative: 'Data/Some Thing.md' }],
  ])('reads %s', (_label, raw, expected) => {
    expect(parseEmbedRef(raw, KB)).toEqual(expected);
  });

  /**
   * EVERY file type the app renders, because the embed renders them all with
   * the app's own renderer. The enterprise panel this grammar came from
   * accepted `.md`, `.html` and `.htm` only — the three its own renderer could
   * draw — and that list would now be a second, narrower answer to "what can
   * be shown".
   */
  it.each(['Shots/diagram.png', 'Docs/Report.pdf', 'Docs/Spec.docx', 'Data/rows.csv', 'Notes/plain.txt'])(
    'reads a path of any type: %s',
    (path) => {
      expect(parseEmbedRef(path, KB)).toEqual({ repoRelative: path });
    },
  );

  it('reads a bare node id as an id, not a path', () => {
    expect(parseEmbedRef('hx-some-ticket', KB)).toEqual({ nodeId: 'hx-some-ticket' });
    expect(parseEmbedRef('hx-some-ticket#notes', KB)).toEqual({
      nodeId: 'hx-some-ticket',
      slug: 'notes',
    });
  });

  it('reads a single segment WITH an extension as a path, not an id', () => {
    expect(parseEmbedRef('AGENTS.md', KB)).toEqual({ repoRelative: 'AGENTS.md' });
  });

  it.each([
    ['empty', ''],
    ['traversal', '../../etc/passwd'],
    ['a traversal inside', 'Data/../../etc/passwd'],
    ['a percent-encoded separator', 'Data%2f..%2fsecret.md'],
    ['a percent-encoded dot', 'Data/%2e%2e/secret.md'],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseEmbedRef(raw, KB)).toThrow(EmbedRefParseError);
  });

  /**
   * A single segment that is not a legal id is a FILE NAME, not a bad id — a
   * space is perfectly legal in one, and the knowledge base is full of them.
   * Only the shape of the trailing segment decides which form a reference is
   * (see `looksLikeNodeId`), and nothing about that is a refusal.
   */
  it('reads a single segment that is not a legal id as a file name', () => {
    expect(parseEmbedRef('Not An Id', KB)).toEqual({ repoRelative: 'Not An Id' });
  });

  it('refuses a malformed percent-escape rather than throwing a URIError', () => {
    expect(() => parseEmbedRef('Data/%zz.md', KB)).toThrow(EmbedRefParseError);
  });
});

describe('isSafeRepoRelativeEmbedPath', () => {
  it('refuses an absolute path, traversal and a control character', () => {
    expect(isSafeRepoRelativeEmbedPath('/etc/passwd')).toBe(false);
    expect(isSafeRepoRelativeEmbedPath('a/../b.md')).toBe(false);
    expect(isSafeRepoRelativeEmbedPath('a\nb.md')).toBe(false);
    expect(isSafeRepoRelativeEmbedPath('')).toBe(false);
  });

  it('accepts a path with no extension at all', () => {
    // Not a node id — it has a separator — and the app renders extensionless
    // text files, so nothing here may refuse it.
    expect(isSafeRepoRelativeEmbedPath('Data/LICENSE')).toBe(true);
  });
});
