import { describe, expect, it } from 'vitest';
import {
  htmlLinksAffectedByMove,
  resolveMdLink,
  rewriteMdLinks,
  scanMarkdownLinks,
} from '@bevel-software/platform-shared';

/**
 * The link grammar `move_file` rewrites with (platform-shared `md-links`):
 * every link form, kept in its form, with code and every other byte untouched.
 */

const KB = 'knowledge-base';

/** A move of `src` to `dest`, as the plan hands it to the rewriter. */
function moveOf(src: string, dest: string) {
  return (p: string): string | null =>
    p === src ? dest : p.startsWith(`${src}/`) ? dest + p.slice(src.length) : null;
}

/** Rewrite `text` sitting at `oldPath` (moving to `newPath`) for a move of `src` to `dest`. */
function rewrite(text: string, oldPath: string, src: string, dest: string, newPath = oldPath) {
  return rewriteMdLinks(text, { oldPath, newPath, mapPath: moveOf(src, dest), kbDirName: KB, branch: 'main' });
}

const OUTSIDE = `${KB}/Pages/Index.md`;
const PLAN = `${KB}/Old/Plan.md`;
const NEW_PLAN = `${KB}/New/Deep/Plan.md`;

describe('md-links — the forms a link to a moved file is written in', () => {
  it('a relative link keeps its anchor and title', () => {
    const { text, edits } = rewrite('See [Plan](../Old/Plan.md#risks "Risks").\n', OUTSIDE, PLAN, NEW_PLAN);
    expect(text).toBe('See [Plan](../New/Deep/Plan.md#risks "Risks").\n');
    expect(edits).toEqual([{ from: '../Old/Plan.md#risks', to: '../New/Deep/Plan.md#risks' }]);
  });

  it('a `./` relative link keeps its `./`', () => {
    const { text } = rewrite('[a](./Old/Plan.md)\n', `${KB}/Index.md`, PLAN, `${KB}/Other/Plan.md`);
    expect(text).toBe('[a](./Other/Plan.md)\n');
  });

  it('a root-anchored /knowledge-base/ link stays root-anchored', () => {
    const { text } = rewrite(`[p](/${PLAN})\n`, OUTSIDE, PLAN, NEW_PLAN);
    expect(text).toBe(`[p](/${NEW_PLAN})\n`);
  });

  it('an app URL /workspace/<branch>/… keeps its branch segment, and one naming another branch is left', () => {
    const { text } = rewrite(
      `[p](/workspace/main/${PLAN}#x) [q](/workspace/other/${PLAN})\n`,
      OUTSIDE,
      PLAN,
      NEW_PLAN,
    );
    expect(text).toBe(`[p](/workspace/main/${NEW_PLAN}#x) [q](/workspace/other/${PLAN})\n`);
  });

  it('an angle-bracket destination stays in angle brackets, spaces unencoded', () => {
    const { text } = rewrite('[p](<../Old Folder/My Plan.md> "t")\n', OUTSIDE, `${KB}/Old Folder`, `${KB}/New Folder`);
    expect(text).toBe('[p](<../New Folder/My Plan.md> "t")\n');
  });

  it('a percent-encoded destination stays encoded', () => {
    const { text } = rewrite('[p](../Old%20Folder/My%20Plan.md)\n', OUTSIDE, `${KB}/Old Folder`, `${KB}/New Folder`);
    expect(text).toBe('[p](../New%20Folder/My%20Plan.md)\n');
  });

  it('a bare destination gaining a space has the space encoded, so the link still parses', () => {
    const { text } = rewrite('[p](../Old/Plan.md)\n', OUTSIDE, PLAN, `${KB}/New Folder/Plan.md`);
    expect(text).toBe('[p](../New%20Folder/Plan.md)\n');
  });

  it('an image to any file type', () => {
    const { text } = rewrite('![shot](../Old/shot.png "Shot")\n', OUTSIDE, `${KB}/Old`, `${KB}/Assets`);
    expect(text).toBe('![shot](../Assets/shot.png "Shot")\n');
  });

  it('a reference definition, angle and bare, with its title', () => {
    const { text } = rewrite(
      '[x][plan]\n\n[plan]: ../Old/Plan.md "Plan"\n[pdf]: <../Old/Spec v2.pdf>\n',
      OUTSIDE,
      `${KB}/Old`,
      `${KB}/Archive`,
    );
    expect(text).toBe('[x][plan]\n\n[plan]: ../Archive/Plan.md "Plan"\n[pdf]: <../Archive/Spec v2.pdf>\n');
  });

  it('a link to a moved FOLDER, trailing slash kept', () => {
    const { text } = rewrite('[all](../Old/) [one](../Old)\n', OUTSIDE, `${KB}/Old`, `${KB}/Archive/Old`);
    expect(text).toBe('[all](../Archive/Old/) [one](../Archive/Old)\n');
  });

  it('a link wrapping an image: both destinations', () => {
    const { text } = rewrite('[![a](../Old/a.png)](../Old/Plan.md)\n', OUTSIDE, `${KB}/Old`, `${KB}/New`);
    expect(text).toBe('[![a](../New/a.png)](../New/Plan.md)\n');
  });

  it('a destination with balanced parentheses', () => {
    const { text } = rewrite('[p](../Old/Plan(v2).md)\n', OUTSIDE, `${KB}/Old`, `${KB}/New`);
    expect(text).toBe('[p](../New/Plan(v2).md)\n');
  });
});

describe('md-links — what a move never changes', () => {
  it('fenced code and inline code are untouched', () => {
    const input = [
      'Real [p](../Old/Plan.md).',
      '',
      '```md',
      '[p](../Old/Plan.md)',
      '```',
      '',
      '~~~~',
      '[p](../Old/Plan.md)',
      '```',
      '~~~~',
      '',
      '- item',
      '  ```',
      '  [p](../Old/Plan.md)',
      '  ```',
      '',
      'Inline `[p](../Old/Plan.md)` and ``a ` [p](../Old/Plan.md) ``.',
      '',
    ].join('\n');
    const { text, edits } = rewrite(input, OUTSIDE, PLAN, NEW_PLAN);
    expect(edits).toHaveLength(1);
    expect(text).toBe(input.replace('Real [p](../Old/Plan.md).', 'Real [p](../New/Deep/Plan.md).'));
  });

  it('indented code blocks are untouched, at the margin and inside a list item', () => {
    const input = [
      'Real [p](../Old/Plan.md).',
      '',
      '    [p](../Old/Plan.md)',
      '',
      '    still code [p](../Old/Plan.md)',
      '',
      '- item',
      '',
      '    list paragraph [p](../Old/Plan.md)',
      '',
      '        [p](../Old/Plan.md)',
      '',
      'para',
      '    lazy [p](../Old/Plan.md)',
      '',
    ].join('\n');
    const { text, edits } = rewrite(input, OUTSIDE, PLAN, NEW_PLAN);
    expect(edits).toHaveLength(3);
    const changed = text.split('\n').filter((l, i) => l !== input.split('\n')[i]);
    expect(changed).toEqual([
      'Real [p](../New/Deep/Plan.md).',
      '    list paragraph [p](../New/Deep/Plan.md)',
      '    lazy [p](../New/Deep/Plan.md)',
    ]);
  });

  it('id-links, external URLs, same-page anchors and escaped brackets are left alone', () => {
    const input = '[a](project-hexis) [b](plan#risks) [c](https://x.y/Old/Plan.md) [d](#risks) \\[e](../Old/Plan.md)\n';
    expect(rewrite(input, OUTSIDE, PLAN, NEW_PLAN).text).toBe(input);
  });

  it('frontmatter: the nodeType link is rewritten and every other line stays byte-identical (CRLF too)', () => {
    const fm = [
      '---',
      'nodeType: "[Task](../NodeTypes/Task.md)"',
      'id: task-a',
      'tags: [a, b]   ',
      'read: "[[Sales]]"',
      '---',
      '',
      '# Name',
      'A task linking [Task](../NodeTypes/Task.md).',
      '',
    ].join('\r\n');
    const { text } = rewrite(fm, `${KB}/Tasks/A.md`, `${KB}/Tasks/A.md`, `${KB}/Tasks/Deep/A.md`, `${KB}/Tasks/Deep/A.md`);
    expect(text).toBe(fm.split('../NodeTypes/Task.md').join('../../NodeTypes/Task.md'));
    const before = fm.split('\r\n');
    const after = text.split('\r\n');
    expect(after.filter((l, i) => l !== before[i])).toEqual([
      'nodeType: "[Task](../../NodeTypes/Task.md)"',
      'A task linking [Task](../../NodeTypes/Task.md).',
    ]);
  });

  it('a file whose links all still resolve comes back unchanged, as the same string', () => {
    const input = `[p](/${KB}/Elsewhere.md) [q](Sibling.md)\n`;
    const out = rewrite(input, `${KB}/A/B.md`, `${KB}/Unrelated.md`, `${KB}/Other.md`);
    expect(out.edits).toEqual([]);
    expect(out.text).toBe(input);
  });
});

describe('md-links — the four placements of a link and a moved file', () => {
  const src = `${KB}/Projects/A`;
  const dest = `${KB}/Topics/Deep/A`;

  it('inside the moved set, outbound: a link out of a moved file follows its target', () => {
    const { text } = rewrite('[t](../../NodeTypes/Task.md)\n', `${src}/One.md`, src, dest, `${dest}/One.md`);
    expect(text).toBe('[t](../../../NodeTypes/Task.md)\n');
  });

  it('between two moved files: the relative link already holds, untouched', () => {
    const out = rewrite('[two](Two.md) [up](../A/Two.md)\n', `${src}/One.md`, src, dest, `${dest}/One.md`);
    expect(out.edits).toEqual([]);
  });

  it('between two moved files, root-anchored: rewritten to the new place', () => {
    const { text } = rewrite(`[two](/${src}/Two.md)\n`, `${src}/One.md`, src, dest, `${dest}/One.md`);
    expect(text).toBe(`[two](/${dest}/Two.md)\n`);
  });

  it('inbound from outside: points at the new place', () => {
    const { text } = rewrite('[one](../Projects/A/One.md)\n', `${KB}/Pages/Index.md`, src, dest);
    expect(text).toBe('[one](../Topics/Deep/A/One.md)\n');
  });
});

describe('md-links — scanning', () => {
  it('finds every destination with its offsets and kind', () => {
    const text = '---\nnodeType: "[T](../T.md)"\n---\n[a](a.md) ![b](b.png)\n\n[c]: c.md\n[^1]: not a definition\n';
    const spans = scanMarkdownLinks(text);
    expect(spans.map((s) => [s.kind, s.destination, s.inFrontmatter])).toEqual([
      ['link', '../T.md', true],
      ['link', 'a.md', false],
      ['image', 'b.png', false],
      ['definition', 'c.md', false],
    ]);
    for (const s of spans) expect(text.slice(s.start, s.end)).toBe(s.destination);
  });

  it('resolves the forms the app resolves', () => {
    const base = `${KB}/A/B.md`;
    expect(resolveMdLink('../C.md#x', { basePath: base, kbDirName: KB })).toEqual({ form: 'relative', branch: null, path: `${KB}/C.md`, hash: '#x' });
    expect(resolveMdLink(`/${KB}/C.md`, { basePath: base, kbDirName: KB })?.path).toBe(`${KB}/C.md`);
    expect(resolveMdLink(`/workspace/main/${KB}/My%20C.md`, { basePath: base, kbDirName: KB })).toEqual({ form: 'workspace', branch: 'main', path: `${KB}/My C.md`, hash: '' });
    expect(resolveMdLink('project-hexis', { basePath: base, kbDirName: KB })).toBeNull();
    expect(resolveMdLink('mailto:a@b', { basePath: base, kbDirName: KB })).toBeNull();
  });

  it('HTML pages: the links a move would break are reported', () => {
    const html = '<a href="../Old/Plan.md">p</a><img src=\'x.png\'><a href="https://x.y">x</a>';
    expect(htmlLinksAffectedByMove(html, { oldPath: OUTSIDE, newPath: OUTSIDE, mapPath: moveOf(PLAN, NEW_PLAN), kbDirName: KB, branch: 'main' }))
      .toEqual(['../Old/Plan.md']);
  });

  it('HTML pages: unquoted attribute values are reported too', () => {
    const html = '<a href=../Old/Plan.md>p</a> <a class=x href = ../Old/Plan.md#r>q</a>';
    expect(htmlLinksAffectedByMove(html, { oldPath: OUTSIDE, newPath: OUTSIDE, mapPath: moveOf(PLAN, NEW_PLAN), kbDirName: KB, branch: 'main' }))
      .toEqual(['../Old/Plan.md', '../Old/Plan.md#r']);
  });
});

describe('md-links — container and frontmatter edges', () => {
  it('a fence-looking line four columns in, inside a paragraph, opens no fence', () => {
    const input = ['para', '    ~~~', '    [p](../Old/Plan.md)', '    ~~~', ''].join('\n');
    expect(rewrite(input, OUTSIDE, PLAN, NEW_PLAN).text).toBe(input.replace('../Old/Plan.md', '../New/Deep/Plan.md'));
    // With backticks the two runs are one inline code span: code, left alone.
    const ticks = input.split('~~~').join('```');
    expect(rewrite(ticks, OUTSIDE, PLAN, NEW_PLAN).text).toBe(ticks);
  });

  it('a fence-looking line four columns in does not close a fence', () => {
    const input = ['```', '    ```', '[p](../Old/Plan.md)', '```', '[q](../Old/Plan.md)', ''].join('\n');
    expect(rewrite(input, OUTSIDE, PLAN, NEW_PLAN).text).toBe(['```', '    ```', '[p](../Old/Plan.md)', '```', '[q](../New/Deep/Plan.md)', ''].join('\n'));
  });

  it('a fence inside a list item still opens and closes at the item’s indent', () => {
    const input = ['- item', '', '  ```', '  [p](../Old/Plan.md)', '  ```', '', '[q](../Old/Plan.md)', ''].join('\n');
    expect(rewrite(input, OUTSIDE, PLAN, NEW_PLAN).text).toBe(input.replace('[q](../Old/Plan.md)', '[q](../New/Deep/Plan.md)'));
  });

  it('a reference definition inside a blockquote is rewritten', () => {
    const input = '> [ref]: ../Old/Plan.md "t"\n> > [deep]: <../Old/Plan.md>\n';
    expect(rewrite(input, OUTSIDE, PLAN, NEW_PLAN).text).toBe('> [ref]: ../New/Deep/Plan.md "t"\n> > [deep]: <../New/Deep/Plan.md>\n');
  });

  it('frontmatter: only a value that is one whole link is rewritten; a link in a prose value is left', () => {
    const fm = [
      '---',
      'nodeType: "[Task](../Old/Plan.md)"',
      "parent: '[P](../Old/Plan.md)'",
      'owner: [P](../Old/Plan.md)',
      'description: "See [P](../Old/Plan.md) for context"',
      'commented: "[P](../Old/Plan.md)"  # YAML drops this [c](../Old/Plan.md)',
      'bare: [P](../Old/Plan.md) # so does this',
      'inside: "[P](../Old/Plan.md) # not a comment"',
      'two: [a](../Old/Plan.md) [b](../Old/Plan.md)',
      '---',
      '',
    ].join('\n');
    const { text } = rewrite(fm, OUTSIDE, PLAN, NEW_PLAN);
    expect(text.split('\n')).toEqual([
      '---',
      'nodeType: "[Task](../New/Deep/Plan.md)"',
      "parent: '[P](../New/Deep/Plan.md)'",
      'owner: [P](../New/Deep/Plan.md)',
      'description: "See [P](../Old/Plan.md) for context"',
      'commented: "[P](../New/Deep/Plan.md)"  # YAML drops this [c](../Old/Plan.md)',
      'bare: [P](../New/Deep/Plan.md) # so does this',
      'inside: "[P](../Old/Plan.md) # not a comment"',
      'two: [a](../Old/Plan.md) [b](../Old/Plan.md)',
      '---',
      '',
    ]);
  });

  it('an image under another branch’s app URL is rewritten — the app serves it from this branch — while a link there is left', () => {
    const { text } = rewrite(
      `![i](/workspace/other/${PLAN}) [q](/workspace/other/${PLAN})\n`,
      OUTSIDE,
      PLAN,
      NEW_PLAN,
    );
    expect(text).toBe(`![i](/workspace/other/${NEW_PLAN}) [q](/workspace/other/${PLAN})\n`);
  });
});
