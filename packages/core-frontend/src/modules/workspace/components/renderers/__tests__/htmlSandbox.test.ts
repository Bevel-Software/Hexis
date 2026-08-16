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

  it('strips external src/href/action/poster/srcset/ping', () => {
    const html = `
      <img src="https://attacker.com/pixel.png" srcset="https://attacker.com/2x.png 2x">
      <a href="https://attacker.com/landing" ping="https://attacker.com/track">x</a>
      <form action="https://attacker.com/submit"></form>
      <video poster="https://attacker.com/thumb.jpg"></video>
      <body background="https://attacker.com/bg.jpg">
    `;
    const out = sanitizeAgentHtml(html);
    expect(out).not.toContain('attacker.com');
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

  it('still strips external and javascript anchors even if they contain .md', () => {
    const out = sanitizeAgentHtml(
      '<a href="https://attacker.com/x.md">x</a><a href="javascript:alert(1)//x.md">y</a>',
    );
    expect(out).not.toContain('attacker.com');
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
