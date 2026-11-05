import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { MD_ID_LINK_RE, resolveMdLink, scanMarkdownLinks } from '@bevel-software/platform-shared';
import { NODE_ID_LINK_RE, resolveKbHref, safeDecode } from '../kb-routes';

/**
 * The link grammar `move_file` rewrites with (platform-shared `md-links`) and
 * the app that renders and follows those links must agree on two things, over
 * one fixture set:
 *   - WHICH destinations a page holds: what the scanner finds in a page's body
 *     is exactly what react-markdown renders as an `href` or `src`;
 *   - WHERE each one points: `resolveMdLink` and `resolveKbHref` give the same
 *     path, branch and anchor, and the same id-link verdict.
 *
 * One deliberate difference is pinned at the end: link syntax inside inline
 * code. Neither the renderer nor the rewriter treats it as a link — but the
 * graph parser and `validate_graph` do, so after a move such a code example
 * reads as dangling there.
 */

const KB = 'knowledge-base';
const BASE = `${KB}/Projects/A/One.md`;

/** The shared fixture set: pages whose every link destination both sides must agree on. */
const PAGES: string[] = [
  '[rel](../B/Two.md) [dot](./Three.md#goal) [up](../../Index.md "Index")',
  `[root](/${KB}/Projects/B/Two.md) [app](/workspace/main/${KB}/Projects/My%20Doc.md#x)`,
  '[angle](<../B/My Doc.md>) [enc](../B/My%20Doc.md) ![img](../assets/shot.png "Shot")',
  '[id](project-hexis) [id-anchor](project-hexis#scope) [same](#overview) [web](https://example.com/a.md)',
  '[ref][r1] and [collapsed][]\n\n[r1]: ../B/Ref.md "Ref"\n[collapsed]: <../B/Col lapsed.md>',
  '[parens](../B/Plan(v2).md) [escaped](../B/a\\_b.md) [![inner](i.png)](../B/Outer.md)',
  '- item [in list](../B/List.md)\n\n> quoted [in quote](../B/Quote.md)\n\n| a | b |\n|---|---|\n| [cell](../B/Cell.md) | x |',
  'Text with `code [not](../B/Code.md)` and\n\n```\n[fenced](../B/Fenced.md)\n```\n\n~~~md\n![fenced](x.png)\n~~~\n\nafter [after](../B/After.md)',
  '---\nnodeType: "[Task](../../NodeTypes/Task.md)"\nid: one\n---\n\n# One\n[body](../B/Body.md)',
  '[folder](../B/) [mangled](junk/knowledge-base/Projects/C.md)',
  // Indented code blocks: four columns in, where a paragraph cannot continue.
  '[before](../B/Before.md)\n\n    [indented](../B/Indented.md)\n    ![x](y.png)\n\n    still code [c](../B/C2.md)\n\n[after](../B/After2.md)',
  '# Heading\n    [code after heading](../B/H.md)\n\npara\n    [lazy continuation](../B/Lazy.md)',
  '\t[tab code](../B/Tab.md)\n\ntext [t](../B/T.md)',
  '- item\n\n    [list paragraph](../B/ListPara.md)\n\n        [list code](../B/ListCode.md)\n\nback [out](../B/Out.md)\n\n    [code again](../B/Code2.md)',
  '1. one\n2. two\n\n   [ordered para](../B/Ord.md)\n\n       [ordered code](../B/OrdCode.md)',
  '> quote\n\n    [code after quote](../B/Q.md)\n\n  [two spaces](../B/Two2.md)',
  // A fence line four columns in opens or closes nothing (a paragraph's continuation, or still code).
  'para\n    ~~~\n    [lazy fence](../B/LazyFence.md)\n    ~~~\n\npara\n    ```\n    [tick span](../B/Span.md)\n    ```',
  '~~~\n    ~~~\n[in fence](../B/InFence.md)\n~~~\n[out of fence](../B/OutFence.md)',
  '- item\n\n  ~~~\n  [list fence](../B/ListFence.md)\n  ~~~\n\n[after list](../B/AfterList.md)',
  // Reference definitions inside blockquotes.
  '> [q1]: ../B/Q1.md "t"\n> > [q2]: <../B/Q 2.md>\n\n[one][q1] [two][q2]',
];

/** The destinations react-markdown renders for a page, in document order, as the attribute values. */
function rendered(page: string): string[] {
  const html = renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm, remarkFrontmatter]}>{page}</Markdown>);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('a[href], img[src]')].map((el) => el.getAttribute(el.tagName === 'A' ? 'href' : 'src')!);
}

/** Destinations compared as what they name: decoded, markdown escapes undone. */
const canonical = (d: string) => safeDecode(d.replace(/\\([!-/:-@[-`{-~])/g, '$1'));

describe('md-links agrees with the app on a shared fixture set', () => {
  it.each(PAGES.map((p, i) => [i, p]))('page %i: the scanner finds exactly the destinations the app renders', (_i, page) => {
    const scanned = scanMarkdownLinks(page).filter((s) => !s.inFrontmatter);
    // The renderer emits a definition where a reference USES it; order by first use.
    const ours = scanned.map((s) => canonical(s.destination)).sort();
    const theirs = rendered(page).map(canonical).sort();
    expect(theirs.length).toBeGreaterThan(0);
    expect(ours).toEqual(theirs);
  });

  it.each(PAGES.map((p, i) => [i, p]))('page %i: every destination resolves to the same place', (_i, page) => {
    for (const span of scanMarkdownLinks(page)) {
      const image = span.kind === 'image';
      const ours = resolveMdLink(span.destination, { basePath: BASE, kbDirName: KB, image });
      const href = canonical(span.destination);
      // The app follows an id-link by id before it resolves anything as a path.
      expect(MD_ID_LINK_RE.test(href), href).toBe(NODE_ID_LINK_RE.test(href));
      if (NODE_ID_LINK_RE.test(href)) {
        expect(ours, href).toBeNull();
        continue;
      }
      const theirs = resolveKbHref(span.destination.replace(/\\([!-/:-@[-`{-~])/g, '$1'), {
        basePath: BASE,
        kbDirName: KB,
        repairMangledPath: !image,
      });
      if (theirs === null || theirs.kind === 'external') {
        expect(ours, href).toBeNull();
        continue;
      }
      // A same-page anchor names the page itself: nothing a move rewrites.
      if (href.startsWith('#')) {
        expect(ours, href).toBeNull();
        continue;
      }
      expect(ours, href).toEqual({
        form: href.startsWith('/workspace/') ? 'workspace' : href.startsWith('/') ? 'root' : 'relative',
        path: theirs.path,
        branch: theirs.branch,
        hash: theirs.hash,
      });
    }
  });

  it('link syntax inside inline code: a link to neither the app nor the rewriter', () => {
    const page = 'Example: `[x](../B/Two.md)`';
    expect(rendered(page)).toEqual([]);
    expect(scanMarkdownLinks(page)).toEqual([]);
  });
});
