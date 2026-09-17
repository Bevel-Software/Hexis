import { describe, expect, it } from 'vitest';
import { markdownLinkForPaste, rootAnchoredPath } from '../pasteLink';

const KB = 'knowledge-base';

describe('rootAnchoredPath', () => {
  it('prefixes a workspace path with a slash, once', () => {
    expect(rootAnchoredPath('knowledge-base/KnowledgeBase/subfile.md')).toBe('/knowledge-base/KnowledgeBase/subfile.md');
    expect(rootAnchoredPath('/knowledge-base/a.md')).toBe('/knowledge-base/a.md');
  });
});

describe('markdownLinkForPaste', () => {
  it('wraps a bare workspace path, labelled with the file name without extension', () => {
    expect(markdownLinkForPaste('/knowledge-base/KnowledgeBase/Foo.md', KB)).toBe('[Foo](/knowledge-base/KnowledgeBase/Foo.md)');
    expect(markdownLinkForPaste('  /knowledge-base/KnowledgeBase/Reports/\n', KB)).toBe('[Reports](/knowledge-base/KnowledgeBase/Reports/)');
  });

  // The link resolver cuts at the first `#` and percent-decodes the path, so
  // both are encoded or the link opens a different file.
  it('percent-encodes # and % in a workspace path destination', () => {
    expect(markdownLinkForPaste('/knowledge-base/KnowledgeBase/C#.md', KB)).toBe('[C#](/knowledge-base/KnowledgeBase/C%23.md)');
    expect(markdownLinkForPaste('/knowledge-base/KnowledgeBase/100%20off.md', KB)).toBe('[100%20off](/knowledge-base/KnowledgeBase/100%2520off.md)');
  });

  it('angle-brackets a destination with spaces', () => {
    expect(markdownLinkForPaste('/knowledge-base/File Type examples/sub file.md', KB)).toBe(
      '[sub file](</knowledge-base/File Type examples/sub file.md>)',
    );
  });

  it('wraps an http(s) URL, labelled with host and path', () => {
    expect(markdownLinkForPaste('https://example.com/docs/guide/', KB)).toBe('[example.com/docs/guide](https://example.com/docs/guide/)');
    expect(markdownLinkForPaste('http://example.com', KB)).toBe('[example.com](http://example.com)');
  });

  it('uses the selection as the label, escaping brackets', () => {
    expect(markdownLinkForPaste('https://example.com/x', KB, 'the [spec]')).toBe('[the \\[spec\\]](https://example.com/x)');
  });

  it('leaves everything else alone', () => {
    for (const text of [
      'hello world',
      'knowledge-base/KnowledgeBase/Foo.md',
      '/other/Foo.md',
      '/knowledge-base/',
      'ftp://example.com/x',
      'https://example.com/a https://example.com/b',
      '/knowledge-base/a.md\n/knowledge-base/b.md',
      '',
    ]) {
      expect(markdownLinkForPaste(text, KB), text).toBeNull();
    }
    expect(markdownLinkForPaste('/knowledge-base/a.md', null)).toBeNull();
  });
});
