import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { sanitizeAgentHtml, buildSandboxedHtml } from '../htmlSandbox';

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

  // Whitespace is stripped for the CHECK, not from the value: an href that
  // survives is handed to the parent exactly as the author wrote it.
  it('keeps a padded page link without rewriting it', () => {
    expect(hrefOf('<a href="  Board.html  ">Board</a>')).toBe('  Board.html  ');
  });

  // Generated markup writes an href on its own line; the address is still an
  // ordinary external one and the reader should reach it.
  it('keeps an external address written across lines, verbatim', () => {
    const padded = '\n      https://example.com/docs\n    ';
    expect(hrefOf(`<a href="${padded}">docs</a>`)).toBe(padded);
  });

  // A scheme only a tab makes valid is nobody's markup, and the parent would
  // refuse to open it anyway — keeping the href would leave a dead link.
  it('takes the href of an address only whitespace-removal makes external', () => {
    expect(hrefOf('<a href="htt\tps://example.com/docs">docs</a>')).toBeNull();
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
    // Delegated anchor-click interception, leaving in-page fragments alone.
    expect(out).toContain("a[href]");
    expect(out).toContain("href.charAt(0) === '#'");
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
