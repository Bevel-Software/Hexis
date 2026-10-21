import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { sanitizeAgentHtml, buildSandboxedHtml } from '../htmlSandbox';
import { runBridge } from './bridgeHarness';

describe('sanitizeAgentHtml', () => {
  it('keeps inline scripts and tags them as modules so they run after the lib', () => {
    const out = sanitizeAgentHtml('<script>console.log("hi")</script>');
    expect(out).toContain('<script type="module"');
    expect(out).toContain('console.log');
  });

  it('strips <script src="https://attacker.com/evil.js">', () => {
    const out = sanitizeAgentHtml('<script src="https://attacker.com/evil.js"></script>');
    expect(out).not.toContain('attacker.com');
    expect(out).not.toContain('<script');
  });

  it('strips <script src="//attacker.com/evil.js"> (protocol-relative)', () => {
    const out = sanitizeAgentHtml('<script src="//attacker.com/evil.js"></script>');
    expect(out).not.toContain('attacker.com');
  });

  it('strips <link rel="stylesheet" href="https://cdn.example.com/x.css">', () => {
    const out = sanitizeAgentHtml('<link rel="stylesheet" href="https://cdn.example.com/x.css">');
    expect(out).not.toContain('cdn.example.com');
    expect(out).not.toContain('<link');
  });

  it('drops <iframe>, <object>, <embed>, <base>, <meta>, <applet>', () => {
    const html = `
      <iframe src="https://attacker.com"></iframe>
      <object data="https://attacker.com/x.swf"></object>
      <embed src="https://attacker.com/x">
      <base href="https://attacker.com/">
      <meta http-equiv="refresh" content="0;url=https://attacker.com">
      <applet code="evil"></applet>
    `;
    const out = sanitizeAgentHtml(html);
    expect(out).not.toMatch(/<iframe/i);
    expect(out).not.toMatch(/<object/i);
    expect(out).not.toMatch(/<embed/i);
    expect(out).not.toMatch(/<base/i);
    expect(out).not.toMatch(/<meta/i);
    expect(out).not.toMatch(/<applet/i);
    expect(out).not.toContain('attacker.com');
  });

  it('strips external src/action/poster/srcset', () => {
    const html = `
      <img src="https://attacker.com/pixel.png" srcset="https://attacker.com/2x.png 2x">
      <form action="https://attacker.com/submit"></form>
      <video poster="https://attacker.com/thumb.jpg"></video>
      <body background="https://attacker.com/bg.jpg">
    `;
    const out = sanitizeAgentHtml(html);
    expect(out).not.toContain('attacker.com');
  });

  // `href` is the anchor's one exception. `ping` is a beacon the browser
  // fires on click without the reader ever seeing where it went, so it goes
  // even on an anchor whose href stays.
  it('strips an anchor ping while keeping its href', () => {
    const out = sanitizeAgentHtml(
      '<a href="https://example.com/landing" ping="https://tracker.example/t">x</a>',
    );
    expect(out).toContain('https://example.com/landing');
    expect(out).not.toContain('tracker.example');
    expect(out).not.toContain('ping=');
  });

  it('strips javascript: URLs', () => {
    const out = sanitizeAgentHtml(
      '<a href="javascript:alert(1)">click</a><img src="javascript:alert(2)">',
    );
    expect(out).not.toContain('javascript:');
  });

  it('strips relative URLs (they would not resolve in srcdoc)', () => {
    const out = sanitizeAgentHtml('<img src="../private/secret.png">');
    expect(out).not.toContain('../private/secret.png');
  });

  it('keeps fragment links', () => {
    const out = sanitizeAgentHtml('<a href="#section1">jump</a>');
    expect(out).toContain('#section1');
  });

  it('keeps internal KB-node links (.md paths and /workspace/ URLs) on anchors', () => {
    const html = `
      <a href="../NodeTypes/Process.md">Process</a>
      <a href="Sub/Node.md#goal">Goal</a>
      <a href="/workspace/main/Folder/Node.md">Citation</a>
    `;
    const out = sanitizeAgentHtml(html);
    expect(out).toContain('../NodeTypes/Process.md');
    expect(out).toContain('Sub/Node.md#goal');
    expect(out).toContain('/workspace/main/Folder/Node.md');
  });

  it('strips node-link-shaped URLs from non-anchor elements', () => {
    // The node-link exception is anchor-only — an <img src> that happens to end
    // in `.md` is still a relative resource that would not resolve in srcdoc.
    const out = sanitizeAgentHtml('<img src="../NodeTypes/Process.md">');
    expect(out).not.toContain('Process.md');
  });

  it('still strips a javascript: anchor even when it contains .md', () => {
    const out = sanitizeAgentHtml('<a href="javascript:alert(1)//x.md">y</a>');
    expect(out).not.toContain('javascript:');
  });

  it('keeps data:image/* URLs', () => {
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
    const out = sanitizeAgentHtml(`<img src="${dataUrl}">`);
    expect(out).toContain(dataUrl);
  });

  it('strips data: URLs that are not images (e.g. data:text/html)', () => {
    const out = sanitizeAgentHtml(
      '<iframe src="data:text/html,<script>alert(1)</script>"></iframe><a href="data:text/html,evil">x</a>',
    );
    expect(out).not.toContain('data:text/html');
  });

  it('preserves inline event handlers (CSP + sandbox keeps them harmless)', () => {
    // `onclick` cannot fetch anything because CSP forbids it; we keep these
    // because the agent legitimately uses them for in-page interactivity.
    const out = sanitizeAgentHtml('<button onclick="alert(1)">x</button>');
    expect(out).toContain('onclick');
  });

  it('hoists <style> from <head> into <body> so agent CSS is preserved', () => {
    const html = `
      <html>
        <head>
          <style>body { background: red }</style>
        </head>
        <body>
          <h1>hello</h1>
        </body>
      </html>
    `;
    const out = sanitizeAgentHtml(html);
    expect(out).toContain('<style>');
    expect(out).toContain('body { background: red }');
    expect(out).toContain('<h1>hello</h1>');
  });

  it('hoists inline <script> from <head> into <body>', () => {
    const html = `
      <html>
        <head><script>console.log('hello')</script></head>
        <body><h1>hi</h1></body>
      </html>
    `;
    const out = sanitizeAgentHtml(html);
    expect(out).toContain('<script type="module"');
    expect(out).toContain("console.log('hello')");
    expect(out).toContain('<h1>hi</h1>');
  });

  it('preserves multiple <style> blocks from <head> in document order', () => {
    const html = `
      <head>
        <style>.first { color: red }</style>
        <style>.second { color: blue }</style>
      </head>
      <body><div></div></body>
    `;
    const out = sanitizeAgentHtml(html);
    const firstIdx = out.indexOf('.first');
    const secondIdx = out.indexOf('.second');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it('survives malformed input without throwing', () => {
    expect(() => sanitizeAgentHtml('<div><span>unclosed')).not.toThrow();
    expect(() => sanitizeAgentHtml('<<><>')).not.toThrow();
    expect(() => sanitizeAgentHtml('')).not.toThrow();
  });
});

/**
 * The Scenarios of "Pages keep static links". A link written in a page's
 * markup keeps its address when it names another document of the knowledge
 * base or an `http:`, `https:` or `mailto:` destination; every other address
 * still loses its href. The click itself is the parent's job — see the
 * `useFileNav.openLink` suite in `routing/__tests__/kb-routes.test.tsx` for
 * where a kept address goes once the reader clicks it.
 */
describe('sanitizeAgentHtml: links written in the page', () => {
  /** The href the sanitizer left on the first anchor, or null if it took it. */
  function hrefOf(html: string): string | null {
    const doc = new DOMParser().parseFromString(sanitizeAgentHtml(html), 'text/html');
    const a = doc.querySelector('a');
    expect(a, 'the anchor itself is never removed, only its href').not.toBeNull();
    return a!.getAttribute('href');
  }

  it('keeps a relative link to another page', () => {
    expect(hrefOf('<a href="Board.html">Board</a>')).toBe('Board.html');
  });

  it('keeps a relative link that walks up a folder, with its fragment', () => {
    expect(hrefOf('<a href="../Reports/Q3.html#totals">Q3</a>')).toBe('../Reports/Q3.html#totals');
  });

  it('keeps a .htm page too', () => {
    expect(hrefOf('<a href="legacy/Index.htm">legacy</a>')).toBe('legacy/Index.htm');
  });

  it('keeps a page named by an absolute /workspace/ address', () => {
    const url = '/workspace/main/knowledge-base/Dashboards/Board.html';
    expect(hrefOf(`<a href="${url}">Board</a>`)).toBe(url);
  });

  it('keeps a .md node link and its heading, as it did before', () => {
    expect(hrefOf('<a href="Sub/Node.md#goal">Goal</a>')).toBe('Sub/Node.md#goal');
    expect(hrefOf('<a href="notes.md">notes</a>')).toBe('notes.md');
  });

  it('keeps an http: and an https: address', () => {
    expect(hrefOf('<a href="https://example.com/docs">docs</a>')).toBe('https://example.com/docs');
    expect(hrefOf('<a href="http://example.com/docs">docs</a>')).toBe('http://example.com/docs');
  });

  it('keeps a mailto: address', () => {
    expect(hrefOf('<a href="mailto:team@example.com">mail us</a>')).toBe(
      'mailto:team@example.com',
    );
  });

  it('keeps the scheme as written, whatever its case', () => {
    expect(hrefOf('<a href="HTTPS://Example.com/Docs">docs</a>')).toBe('HTTPS://Example.com/Docs');
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['disguised by case', ' JaVaScRiPt:alert(1)'],
    ['disguised by a tab inside the scheme', 'java\tscript:alert(1)'],
    ['disguised by a newline inside the scheme', 'java\nscript:alert(1)'],
    ['disguised by a leading control character', '\u0001javascript:alert(1)'],
    ['data:', 'data:text/html,<b>evil</b>'],
    ['data:image, which only an <img> may carry', 'data:image/png;base64,AAAA'],
    ['file:', 'file:///etc/passwd'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['an app scheme nobody named', 'x-devonthink-item:4F2A'],
    ['tel:, openable elsewhere but not mintable by a page', 'tel:+15551234'],
    ['protocol-relative', '//cdn.example.com/x.html'],
    ['a relative path that is not a document', 'assets/report.pdf'],
    ['a bare directory', '../Reports/'],
  ])('takes the href of %s', (_label, url) => {
    expect(hrefOf(`<a href="${url}">x</a>`)).toBeNull();
  });

  // The parser decodes entities before we ever see the value, so a scheme
  // spelled in entities is the same string as one spelled in letters.
  it('takes the href of a javascript: address written in HTML entities', () => {
    expect(hrefOf('<a href="&#106;avascript&#58;alert(1)">x</a>')).toBeNull();
    expect(hrefOf('<a href="java&#9;script:alert(1)">x</a>')).toBeNull();
  });

  // Whitespace is stripped for the CHECK, not from the value: the sanitizer
  // does not rewrite an author's markup. The CLICK is where it matters, and
  // the nav bridge and the parent's resolver apply the same rule, so the
  // address followed is `Board.html` and not a filename with spaces on it.
  it('keeps a padded page link without rewriting it', () => {
    expect(hrefOf('<a href="  Board.html  ">Board</a>')).toBe('  Board.html  ');
  });

  // Generated markup writes an href on its own line; the address is still an
  // ordinary external one and the reader should reach it.
  it('keeps an external address written across lines, verbatim', () => {
    const padded = '\n      https://example.com/docs\n    ';
    expect(hrefOf(`<a href="${padded}">docs</a>`)).toBe(padded);
  });

  // A scheme only a tab makes valid is nobody's markup, but a browser reads
  // `htt<tab>ps:` as `https:` and so does every reader of an href here — the
  // bridge posts the normalized address and the parent opens it. Keeping it is
  // therefore a live link to the address a browser would have followed, not a
  // dead one. The decision is the same whichever way the tab falls: the
  // normalized string is checked against the allowlist, so a tab cannot turn
  // a rejected scheme into an accepted one.
  it('keeps an address a browser reads as external even with a tab in the scheme', () => {
    expect(hrefOf('<a href="htt\tps://example.com/docs">docs</a>')).toBe(
      'htt\tps://example.com/docs',
    );
    // …and the same reading still refuses the dangerous ones.
    expect(hrefOf('<a href="javas\tcript:alert(1)">x</a>')).toBeNull();
    expect(hrefOf('<a href="da\tta:text/html,evil">x</a>')).toBeNull();
  });

  it('keeps an empty href alone, as an anchor with nowhere to go', () => {
    expect(hrefOf('<a href="">x</a>')).toBe('');
  });

  // The exception is anchor + href. Nothing else gains an address.
  it('does not extend the exception to other elements or attributes', () => {
    const out = sanitizeAgentHtml(`
      <img src="Board.html">
      <img src="https://example.com/x.png">
      <script src="https://example.com/x.js"></script>
      <form action="https://example.com/submit"></form>
      <a href="Board.html" cite="https://example.com/why">Board</a>
    `);
    expect(out).toContain('Board.html');
    expect(out).not.toContain('example.com');
    expect(out).not.toMatch(/src="Board\.html"/);
  });
});

describe('buildSandboxedHtml', () => {
  const okOpts = {
    title: 'Test',
    libModuleSources: ['export const x = 1;'],
    bodyHtml: '<h1>hello</h1>',
  };

  it('embeds a strict CSP that forbids external network and external scripts', () => {
    const out = buildSandboxedHtml(okOpts);
    expect(out).toMatch(
      /<meta http-equiv="Content-Security-Policy" content="[^"]*default-src 'none'/,
    );
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain("form-action 'none'");
    expect(out).toContain("base-uri 'none'");
    expect(out).toContain("frame-src 'none'");
    expect(out).toContain('img-src data:');
  });

  it('includes the lib source verbatim and exposes window.bevel', () => {
    const out = buildSandboxedHtml({
      ...okOpts,
      libModuleSources: ['function buildGraph(){}', 'class KnowledgeGraph {}'],
    });
    expect(out).toContain('function buildGraph(){}');
    expect(out).toContain('class KnowledgeGraph {}');
    expect(out).toContain('globalThis.bevel = {');
    expect(out).toContain('buildGraph');
    expect(out).toContain('KnowledgeGraph');
  });

  it('does NOT reference NodeType-class identifiers in the globals literal', () => {
    // Regression: NodeType classes (Process, ValueSlice, ValueGroup, …) are
    // created at runtime by the parser, not exported as bare identifiers.
    // Listing them in the globals object literal throws `ReferenceError:
    // Process is not defined` before `globalThis.bevel` is assigned, which
    // breaks every agent-authored viewer in the iframe. The globals literal
    // must reference only real library exports.
    const out = buildSandboxedHtml(okOpts);
    const literal = out.match(/globalThis\.bevel\s*=\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(literal).not.toMatch(/\bProcess\b/);
    expect(literal).not.toMatch(/\bValueSlice\b/);
    expect(literal).not.toMatch(/\bValueGroup\b/);
    expect(literal).not.toMatch(/\bNODE_CLASS_MAP\b/);
  });

  it('strips relative-path imports between concatenated lib files', () => {
    const out = buildSandboxedHtml({
      ...okOpts,
      libModuleSources: [
        "import { Foo } from './foo.js';\nclass Bar {}",
        "import './side-effect.js';\nclass Baz extends Bar {}",
      ],
    });
    expect(out).not.toMatch(/^[ \t]*import\b/m);
    expect(out).toContain('class Bar {}');
    expect(out).toContain('class Baz extends Bar {}');
  });

  it('strips multi-line relative imports spanning several lines', () => {
    const out = buildSandboxedHtml({
      ...okOpts,
      libModuleSources: [
        `import {\n  Link,\n  Field,\n  KnowledgeNode,\n} from './knowledge-graph.js';\nconst x = 1;`,
      ],
    });
    expect(out).not.toMatch(/^[ \t]*import\b/m);
    expect(out).not.toContain("from './knowledge-graph.js'");
    expect(out).toContain('const x = 1;');
  });

  it('does not strip non-relative dynamic imports (Node-only branches)', () => {
    const out = buildSandboxedHtml({
      ...okOpts,
      libModuleSources: ["const fs = await import('node:fs/promises');"],
    });
    expect(out).toContain("import('node:fs/promises')");
  });

  it('escapes </script> sequences so they cannot terminate the inline script early', () => {
    const out = buildSandboxedHtml({
      ...okOpts,
      libModuleSources: ['const s = "</script><img src=x onerror=alert(1)>";'],
    });
    expect(out).not.toContain('</script><img');
    expect(out).toContain('<\\/script>');
  });

  it('HTML-escapes the title to prevent attribute injection', () => {
    const out = buildSandboxedHtml({
      ...okOpts,
      title: 'foo "><script>alert(1)</script>',
    });
    expect(out).not.toContain('"><script>');
    expect(out).toContain('&quot;');
    expect(out).toContain('&lt;script');
  });

  it('injects the node-navigation bridge (openNode + a-click → bevel.navigate)', () => {
    const out = buildSandboxedHtml(okOpts);
    // Programmatic entry points for graph viewers.
    expect(out).toContain('globalThis.bevel.openNode = navigate');
    expect(out).toContain('globalThis.bevel.navigate = navigate');
    // Posts to the parent rather than navigating the (sandboxed) host window.
    expect(out).toContain("type: 'bevel.navigate'");
    expect(out).toContain('parent.postMessage');
    // Delegated anchor-click interception; a bare fragment is jumped to here.
    expect(out).toContain("a[href]");
    expect(out).toContain('jumpTo(href)');
  });

  // A key pressed inside the frame never reaches the app, so the app's
  // Escape (a card's close, leaving full screen) would go deaf once the
  // reader clicked into the page. The frame hands the parent an Escape the
  // page did not use, and nothing else.
  it('hands the parent an Escape the page left alone, and no other key', async () => {
    const bridge = runBridge();
    await bridge.press('Escape');
    await bridge.press('a');
    await bridge.press('Enter');
    expect(bridge.posted).toEqual([{ type: 'bevel.key', key: 'Escape' }]);
  });

  it('keeps an Escape the page cancelled to the page', async () => {
    const bridge = runBridge();
    await bridge.press('Escape', { alreadyPrevented: true });
    expect(bridge.posted).toEqual([]);
  });

  // A handler the page adds after the bridge ran comes after the bridge's in
  // the same phase; the page's word on the key is final only once the
  // dispatch is over, so that is when the bridge reads it.
  it('keeps an Escape to the page when a handler of its own cancels it after the bridge\'s', async () => {
    const bridge = runBridge();
    await bridge.press('Escape', { preventedAfter: true });
    expect(bridge.posted).toEqual([]);
  });

  it('injects no height reporter: the frame tells its parent where a link goes, never how tall it is', () => {
    // The frame's height is the reader's (`frameResizeHandle.ts`), never
    // read off the page: a page laid out in the frame and measured there
    // feeds the frame's height back into itself.
    const out = buildSandboxedHtml({ title: 't', libModuleSources: [], bodyHtml: '' });
    expect(out).not.toContain('bevel.height');
    expect(out).not.toContain('ResizeObserver');
  });

  // The bridge half of the one-rule promise. The sanitizer keeps a padded
  // href by reading past the padding; the bridge has to hand the parent the
  // same reading, or the resolver builds a path out of the spaces. A padded
  // `#goal` is still an in-page anchor, scrolled to in the frame.
  it('posts the href a browser would follow, and scrolls to a padded fragment', () => {
    const bridge = runBridge({ ids: ['goal'] });

    bridge.click('\n      Board.html\n    ');
    bridge.click('  #goal  ');
    bridge.click('  https://example.com/docs  ');
    // An empty href goes nowhere, and its default is still cancelled: left to
    // the browser it would reload the frame against the app's URL.
    expect(bridge.click('  ')).toEqual({ prevented: true });
    expect(bridge.click('')).toEqual({ prevented: true });

    expect(bridge.posted).toEqual([
      { type: 'bevel.navigate', href: 'Board.html' },
      { type: 'bevel.navigate', href: 'https://example.com/docs' },
    ]);
    expect(bridge.scrolled).toEqual(['goal']);
  });

  /**
   * A bare fragment is an in-page jump by either route. Left to the browser, a
   * `srcdoc` frame resolves `#totals` against the APP's URL and navigates
   * itself away; handed to the parent, the app re-opens the same file with
   * the fragment on its URL and the page does not move. So the bridge
   * cancels the click, scrolls in the frame, and posts nothing.
   */
  describe('a bare fragment scrolls the page inside the frame', () => {
    it('on a click: the element scrolls into view, the default is cancelled, nothing is posted', () => {
      const bridge = runBridge({ ids: ['totals'] });
      expect(bridge.click('#totals')).toEqual({ prevented: true });
      expect(bridge.scrolled).toEqual(['totals']);
      expect(bridge.posted).toEqual([]);
    });

    it('through window.bevel.openNode and window.bevel.navigate the same', () => {
      for (const member of ['openNode', 'navigate']) {
        const bridge = runBridge({ ids: ['totals'] });
        (bridge.bevel[member] as (href: string) => void)('#totals');
        expect(bridge.scrolled, member).toEqual(['totals']);
        expect(bridge.posted, member).toEqual([]);
      }
    });

    it('a fragment naming no element does nothing: no scroll, no navigation, and the default still cancelled', () => {
      const bridge = runBridge({ ids: ['totals'] });
      expect(bridge.click('#nowhere')).toEqual({ prevented: true });
      (bridge.bevel.openNode as (href: string) => void)('#nowhere');
      expect(bridge.scrolled).toEqual([]);
      expect(bridge.scrolledToTop()).toBe(0);
      expect(bridge.posted).toEqual([]);
    });

    it('`#` and `#top` with no such element scroll to the top; an element named top wins', () => {
      const bridge = runBridge();
      bridge.click('#');
      bridge.click('#top');
      bridge.click('#TOP');
      expect(bridge.scrolledToTop()).toBe(3);
      expect(bridge.posted).toEqual([]);
      // An id and a named anchor both win over the top of the page.
      for (const page of [{ ids: ['top'] }, { names: ['top'] }]) {
        const withTop = runBridge(page);
        withTop.click('#top');
        expect(withTop.scrolled, JSON.stringify(page)).toEqual(['top']);
        expect(withTop.scrolledToTop(), JSON.stringify(page)).toBe(0);
      }
    });

    it('finds the target by a percent-encoded id and by an anchor name', () => {
      const bridge = runBridge({ ids: ['Q3 totals'], names: ['legacy'] });
      bridge.click('#Q3%20totals');
      bridge.click('#legacy');
      expect(bridge.scrolled).toEqual(['Q3 totals', 'legacy']);
      // A malformed escape is looked up as written, and nothing breaks.
      bridge.click('#100%');
      expect(bridge.scrolled).toEqual(['Q3 totals', 'legacy']);
      expect(bridge.posted).toEqual([]);
    });

    // The standard's fallback is the named ANCHOR: a form control carrying
    // the name is not a target, even when it comes first in the document.
    it('a name on a form control is not a fragment target; only <a name> is', () => {
      const bridge = runBridge({ names: ['legacy'], namedControls: ['legacy', 'query'] });
      const { prevented } = bridge.click('#query');
      expect(bridge.scrolled).toEqual([]);
      expect(prevented).toBe(true);
      // The control comes first in document order; the anchor is the target.
      bridge.click('#legacy');
      expect(bridge.scrolled).toEqual(['legacy']);
      expect(bridge.scrolledTags).toEqual(['A']);
      expect(bridge.posted).toEqual([]);
    });

    it('leaves a click that is not on a link alone — a button, a div — whatever it carries', () => {
      const bridge = runBridge({ ids: ['goal'] });
      const { prevented } = bridge.click('#goal', { noAnchor: true });
      expect(prevented).toBe(false);
      expect(bridge.scrolled).toEqual([]);
      expect(bridge.posted).toEqual([]);
    });

    // The HTML standard's order: the fragment as written names the target
    // first, its decoding only when that finds nothing.
    it('prefers the id as written over its percent-decoding, as a browser does', () => {
      const bridge = runBridge({ ids: ['Q3%20totals', 'Q3 totals'] });
      bridge.click('#Q3%20totals');
      expect(bridge.scrolled).toEqual(['Q3%20totals']);
    });

    it('leaves a click the page already cancelled to the page: no scroll, nothing posted', () => {
      const bridge = runBridge({ ids: ['panel'] });
      bridge.click('#panel', { alreadyPrevented: true });
      bridge.click('#', { alreadyPrevented: true });
      bridge.click('../Knowledge/Alice.md', { alreadyPrevented: true });
      expect(bridge.scrolled).toEqual([]);
      expect(bridge.scrolledToTop()).toBe(0);
      expect(bridge.posted).toEqual([]);
    });

    it('a document link with a trailing fragment still goes to the app, and scrolls nothing', () => {
      const bridge = runBridge({ ids: ['goal'] });
      expect(bridge.click('../Knowledge/Alice.md#goal')).toEqual({ prevented: true });
      (bridge.bevel.openNode as (href: string) => void)('../Knowledge/Alice.md#goal');
      expect(bridge.posted).toEqual([
        { type: 'bevel.navigate', href: '../Knowledge/Alice.md#goal' },
        { type: 'bevel.navigate', href: '../Knowledge/Alice.md#goal' },
      ]);
      expect(bridge.scrolled).toEqual([]);
    });

    it('a fragment the parent hands back (a link to this page by its own name) scrolls as a bare one does', async () => {
      const bridge = runBridge({ ids: ['q3'] });
      await bridge.deliver({ type: 'bevel.jump', hash: '#q3' });
      expect(bridge.scrolled).toEqual(['q3']);
      expect(bridge.posted).toEqual([]);
    });

    it('takes a jump from the parent only: a message from anywhere else scrolls nothing', async () => {
      const bridge = runBridge({ ids: ['q3'] });
      await bridge.deliver({ type: 'bevel.jump', hash: '#q3' }, { fromParent: false });
      await bridge.deliver({ type: 'bevel.jump', hash: 'q3' });
      expect(bridge.scrolled).toEqual([]);
    });
  });

  it('embeds the body HTML verbatim (sanitization happens upstream)', () => {
    const out = buildSandboxedHtml({
      ...okOpts,
      bodyHtml: '<h1>Process Map</h1>',
    });
    expect(out).toContain('<h1>Process Map</h1>');
  });

  // NOTE (core split): the "inlines mermaid alongside d3" and "inlines d3 as a
  // global" tests moved with the vendored d3/mermaid sources — the vendor
  // bundle (vite-vendor-plugin + renderers/vendor.ts) is part of the
  // enterprise knowledge system. Core builds sandboxed HTML with no inlined
  // vendor libraries; a generic lib-source path is still covered below.
  it('executes generic lib sources in the sandbox script (vm smoke)', () => {
    const out = buildSandboxedHtml({
      ...okOpts,
      libModuleSources: ['globalThis.__coreLibRan = true;'],
    });
    const scriptMatch = out.match(/<script type="module">([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const scriptBody = scriptMatch![1];

    const ctx: { __coreLibRan?: boolean } = {};
    vm.createContext(ctx);
    // Wrap in a strict-mode IIFE so `this` is undefined at top level — same
    // as the iframe's module script.
    vm.runInContext(`"use strict"; (function(){ ${scriptBody} }).call(undefined);`, ctx);

    expect(ctx.__coreLibRan).toBe(true);
  });
});

describe('window.bevel.tools in the frame', () => {
  type Tools = Record<'searchTools' | 'toolsInfo' | 'callTool' | 'callToolChain' | 'uploadFile', (...a: unknown[]) => Promise<unknown>>;
  const toolsOf = (bridge: ReturnType<typeof runBridge>) => bridge.bevel.tools as Tools | null;

  it('has the five functions where the app answers tools, each posting a call with a request id', async () => {
    const bridge = runBridge({}, { toolBridge: true });
    const tools = toolsOf(bridge)!;
    expect(Object.keys(tools).sort()).toEqual(['callTool', 'callToolChain', 'searchTools', 'toolsInfo', 'uploadFile']);
    void tools.searchTools('change request');
    void tools.toolsInfo(['read_file']);
    void tools.callTool('read_file', { body: { path: 'a.md' } });
    void tools.callToolChain('return 1');
    const file = new Blob(['a,b\n']);
    void tools.uploadFile(file, { name: 'Budget.csv', branch: 'main', destination: 'Data', mode: 'overwrite', all: true });
    const posted = bridge.posted as Array<{ type: string; requestId: string; fn: string; args: unknown[] }>;
    expect(posted.map((m) => [m.type, m.fn, m.args])).toEqual([
      ['bevel.tool.call', 'searchTools', ['change request']],
      ['bevel.tool.call', 'toolsInfo', [['read_file']]],
      ['bevel.tool.call', 'callTool', ['read_file', { body: { path: 'a.md' } }]],
      ['bevel.tool.call', 'callToolChain', ['return 1']],
      // The file itself, for the parent to clone; of the options, only the four it reads.
      ['bevel.tool.call', 'uploadFile', [file, { name: 'Budget.csv', branch: 'main', destination: 'Data', mode: 'overwrite' }]],
    ]);
    expect((posted[4]!.args as unknown[])[0]).toBe(file);
    expect(new Set(posted.map((m) => m.requestId)).size).toBe(5);
  });

  it("resolves with the parent's answer and rejects with its error and code, matched by request id", async () => {
    const bridge = runBridge({}, { toolBridge: true });
    const tools = toolsOf(bridge)!;
    const read = tools.callTool('read_file', {});
    const write = tools.callTool('edit_file', {});
    const [readMsg, writeMsg] = bridge.posted as Array<{ requestId: string }>;
    // Handled before the answer arrives, so the rejection is never unhandled.
    const writeRejects = expect(write).rejects.toMatchObject({ message: 'denied', code: 'denied' });
    await bridge.deliver({ type: 'bevel.tool.response', requestId: writeMsg!.requestId, ok: false, error: 'denied', code: 'denied' });
    await bridge.deliver({ type: 'bevel.tool.response', requestId: readMsg!.requestId, ok: true, result: { content: 'hi' } });
    await expect(read).resolves.toEqual({ content: 'hi' });
    await writeRejects;
  });

  it('believes no answer that does not come from the parent', async () => {
    const bridge = runBridge({}, { toolBridge: true });
    let settled = false;
    void toolsOf(bridge)!.callTool('read_file', {}).finally(() => (settled = true));
    const [msg] = bridge.posted as Array<{ requestId: string }>;
    await bridge.deliver({ type: 'bevel.tool.response', requestId: msg!.requestId, ok: true, result: 'forged' }, { fromParent: false });
    expect(settled).toBe(false);
  });

  it('is null where the app answers no tools, and requireTools asks the parent and resolves with its answer', async () => {
    const bridge = runBridge();
    expect(bridge.bevel.tools).toBeNull();
    const required = (bridge.bevel.requireTools as () => Promise<boolean>)();
    const [msg] = bridge.posted as Array<{ type: string; requestId: string }>;
    expect(msg!.type).toBe('bevel.tools.require');
    await bridge.deliver({ type: 'bevel.tools.require.response', requestId: msg!.requestId, ok: true, result: false });
    await expect(required).resolves.toBe(false);

    const onFilePage = runBridge({}, { toolBridge: true });
    const yes = (onFilePage.bevel.requireTools as () => Promise<boolean>)();
    const [ask] = onFilePage.posted as Array<{ requestId: string }>;
    await onFilePage.deliver({ type: 'bevel.tools.require.response', requestId: ask!.requestId, ok: true, result: true });
    await expect(yes).resolves.toBe(true);
  });
});
