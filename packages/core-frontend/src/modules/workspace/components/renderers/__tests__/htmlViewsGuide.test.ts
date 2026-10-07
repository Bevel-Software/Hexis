import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sanitizeAgentHtml } from '../htmlSandbox';
import { runBridge } from './bridgeHarness';

/**
 * The `html-views` section of the agent guide states the frame's link rules
 * to every agent that writes a page; this file holds it to the renderer that
 * enforces them. The section is core-backend's file and is read here as TEXT,
 * in a test only — the two packages still do not import each other. When the
 * section and the sanitizer or the bridge disagree, this fails, whichever of
 * the two moved.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SECTION_FILE = join(HERE, '../../../../../../../core-backend/agent-guide/html-views.md');
// Any knowledge folder name will do: the placeholder only sits inside a path.
const guide = readFileSync(SECTION_FILE, 'utf8').replace(/\{\{\w+\}\}/g, 'KnowledgeBase');
const flat = guide.replace(/\s+/g, ' ');

/**
 * The example hrefs of the bullet list under the line starting `intro`: each
 * bullet names a shape, then ` — ` and the shape's examples in backticks.
 */
function examplesUnder(intro: string): string[][] {
  const lines = guide.split('\n');
  let at = lines.findIndex((l) => l.startsWith(intro));
  expect(at, `the section has no line starting "${intro}"`).toBeGreaterThan(-1);
  while (at < lines.length && !lines[at]!.startsWith('- ')) at += 1;
  const bullets: string[][] = [];
  for (; at < lines.length && lines[at]!.startsWith('- '); at += 1) {
    const tail = lines[at]!.split(' — ')[1];
    expect(tail, `bullet without examples: ${lines[at]}`).toBeTruthy();
    bullets.push([...tail!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
  }
  expect(bullets.length).toBeGreaterThan(0);
  return bullets;
}

/** The href an `<a>` keeps after the sanitizer, or null when it was removed. */
function hrefAfterSanitizing(href: string): string | null {
  const html = sanitizeAgentHtml(`<a href="${href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">x</a>`);
  const a = new DOMParser().parseFromString(html, 'text/html').querySelector('a')!;
  return a.getAttribute('href');
}

describe('the html-views guide section agrees with the renderer', () => {
  const kept = examplesUnder('An `<a href>` in the page keeps its address only when').flat();
  const removed = examplesUnder('Every other address is removed').flat();

  it('every link it lists as surviving is kept by the sanitizer, as written', () => {
    for (const href of kept) expect(hrefAfterSanitizing(href), href).toBe(href);
  });

  it('every link it lists as removed loses its href', () => {
    for (const href of removed) expect(hrefAfterSanitizing(href), href).toBeNull();
  });

  it('lists every shape the sanitizer keeps, and the ones it removes', () => {
    // The kept list is complete: one example of each shape `isKeptLink` keeps.
    const keptShapes: [string, (h: string) => boolean][] = [
      ['.md document', (h) => /\.md(#|$)/.test(h)],
      ['.md document with a heading', (h) => /\.md#/.test(h)],
      ['.html document', (h) => /\.html$/.test(h)],
      ['.htm document', (h) => /\.htm$/.test(h)],
      ['/workspace/ URL', (h) => h.startsWith('/workspace/')],
      ['http:', (h) => h.startsWith('http:')],
      ['https:', (h) => h.startsWith('https:')],
      ['mailto:', (h) => h.startsWith('mailto:')],
      ['bare fragment', (h) => h.startsWith('#')],
    ];
    for (const [shape, is] of keptShapes) expect(kept.some(is), shape).toBe(true);
    const removedShapes: [string, (h: string) => boolean][] = [
      ['javascript:', (h) => h.startsWith('javascript:')],
      ['data:', (h) => h.startsWith('data:')],
      ['protocol-relative', (h) => h.startsWith('//')],
      ['relative path to a non-document', (h) => !/^[a-z]+:|^\/|^#/i.test(h)],
    ];
    for (const [shape, is] of removedShapes) expect(removed.some(is), shape).toBe(true);
  });

  it('says a bare fragment scrolls the page, and the bridge does exactly that', () => {
    expect(flat).toContain('**A bare fragment scrolls the page.**');
    expect(flat).toContain('the page stays loaded and the app does not move');
    expect(flat).toContain('A fragment that names no element does nothing, except `#` and `#top`, which scroll to the top of the page');
    expect(flat).toContain('The same rules apply to a click on a link and to `window.bevel.openNode(href)` or `window.bevel.navigate(href)`');

    for (const route of ['click', 'openNode', 'navigate'] as const) {
      const bridge = runBridge({ ids: ['totals'] });
      const go = (href: string) =>
        route === 'click' ? bridge.click(href) : (bridge.bevel[route] as (h: string) => void)(href);
      go('#totals');
      go('#nowhere');
      go('#');
      go('#top');
      expect(bridge.scrolled, route).toEqual(['totals']);
      expect(bridge.scrolledToTop(), route).toBe(2);
      expect(bridge.posted, route).toEqual([]);
    }
  });

  it('every non-fragment link it lists as surviving goes to the app through the bridge', () => {
    const bridge = runBridge();
    const leaving = kept.filter((h) => !h.startsWith('#'));
    for (const href of leaving) expect(bridge.click(href), href).toEqual({ prevented: true });
    expect(bridge.posted).toEqual(leaving.map((href) => ({ type: 'bevel.navigate', href })));
  });

  it('names exactly the window.bevel members core defines, and leaves data members to a distribution', () => {
    const named = new Set([...guide.matchAll(/window\.bevel\??\.(\w+)/g)].map((m) => m[1]!));
    expect([...named].sort()).toEqual(Object.keys(runBridge().bevel).sort());
    expect([...named].sort()).toEqual(['navigate', 'openNode']);
    expect(flat).toContain('A distribution may add data members of its own to `window.bevel`');
  });
});
