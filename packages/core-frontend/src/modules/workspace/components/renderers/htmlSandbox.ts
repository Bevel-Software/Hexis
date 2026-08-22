/**
 * Sandboxing utilities for the HTML renderer.
 *
 * The threat model: agent-authored HTML in the workspace is treated as
 * untrusted. It runs in an iframe with `sandbox="allow-scripts"` (no
 * `allow-same-origin`, no `allow-popups`, no `allow-top-navigation`,
 * no `allow-forms`) and a strict Content-Security-Policy that forbids
 * outbound network of any kind. The only data channel between the iframe
 * and the parent is `postMessage`, which the parent validates.
 *
 * This module provides two pieces:
 *
 *   1. `sanitizeAgentHtml` — defense-in-depth pre-processing that strips
 *      external URLs (and dangerous elements like <script src>, <link>,
 *      <iframe>, <object>, <embed>, <base>, <meta>) from the agent's HTML
 *      before it is bundled into the srcdoc. CSP would block these at runtime
 *      anyway, but stripping ahead of time makes the bundled document
 *      smaller, easier to audit, and removes any chance a future CSP
 *      misconfiguration accidentally leaks something through.
 *
 *   2. `buildSandboxedHtml` — wraps the sanitized body and the inlined
 *      knowledge-base JS library into a complete HTML document with the
 *      strict CSP and a single inline `<script type="module">` containing
 *      the library code (so `window.bevel.buildGraph()` is callable from
 *      the agent's own scripts).
 */

const DROP_ELEMENTS = new Set([
  'link',
  'iframe',
  'object',
  'embed',
  'base',
  'applet',
  'frame',
  'frameset',
  'meta',
]);

const URL_ATTRIBUTES = [
  'src',
  'href',
  'action',
  'formaction',
  'background',
  'poster',
  'cite',
  'data',
  'srcset',
  'ping',
  'manifest',
  'archive',
  'codebase',
  'longdesc',
  'profile',
  'usemap',
];

/**
 * Decide whether a URL value is allowed to remain on a sanitized element.
 * Keep only fragment links and inline `data:image/*` URLs — every other
 * shape (absolute URL, protocol-relative, scheme-bearing, or plain
 * relative path that the browser would resolve against `about:srcdoc`)
 * is stripped.
 */
function isAllowedUrl(rawUrl: string): boolean {
  const url = rawUrl.trim().toLowerCase();
  if (url === '') return true;
  if (url.startsWith('#')) return true;
  if (url.startsWith('data:image/')) return true;
  return false;
}

/**
 * Decide whether an `<a href>` deep-links to a node in the knowledge graph:
 * either a `.md` node path (optionally with a `#heading` anchor, e.g.
 * `../NodeTypes/Process.md#goal`) or an absolute `/workspace/<branch>/<path>`
 * citation URL — the same shapes the markdown renderer treats as internal
 * links.
 *
 * These survive sanitization (unlike other relative URLs, which are stripped):
 * the iframe sandbox forbids navigating the top window, so the runtime
 * intercepts the click and asks the parent to navigate instead of letting the
 * browser attempt — and error on — the navigation. Any scheme-bearing
 * (`http:`, `javascript:`, …) or protocol-relative (`//host`) URL is rejected.
 */
function isInternalNodeLink(rawUrl: string): boolean {
  const url = rawUrl.trim();
  if (url === '') return false;
  if (url.startsWith('//')) return false; // protocol-relative
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false; // any URL scheme
  if (url.startsWith('/workspace/')) return true;
  return /\.md(#|$)/i.test(url);
}

/**
 * Strip dangerous elements and external URL attributes from agent-authored
 * HTML. Returns the cleaned-up `<body>` inner HTML — the bundler wraps it
 * in our own `<html>` / `<head>` shell.
 */
export function sanitizeAgentHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Hoist <style> and inline <script> from <head> into the start of <body>.
  // The bundler emits its own <head> (CSP, charset, title), so we serialize
  // only the body's inner HTML at the end. Without this hoist, agent-authored
  // CSS in `<head><style>…</style></head>` — which is where most authors put
  // it — would be silently dropped, producing an unstyled page.
  const headHoist: Element[] = [];
  for (const el of Array.from(doc.head.children)) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || (tag === 'script' && !el.hasAttribute('src'))) {
      headHoist.push(el);
    }
  }
  if (headHoist.length) doc.body.prepend(...headHoist);

  // Drop disallowed elements outright.
  for (const tag of DROP_ELEMENTS) {
    const els = doc.querySelectorAll(tag);
    for (let i = 0; i < els.length; i += 1) els[i].remove();
  }

  // Handle `<script>` tags. External `<script src>` is dropped outright (the
  // CSP would block it anyway, but stripping keeps the bundled doc clean).
  // Inline scripts are converted to `<script type="module">` so they execute
  // in source order *after* the knowledge-base library module — this
  // guarantees `window.bevel.buildGraph()` is defined by the time the agent's
  // code runs. Module scripts also implicitly defer until the document is
  // parsed, so DOM lookups like `document.getElementById('app')` work without
  // an explicit `DOMContentLoaded` wait.
  const scripts = doc.querySelectorAll('script');
  for (let i = 0; i < scripts.length; i += 1) {
    const el = scripts[i];
    if (el.hasAttribute('src')) {
      el.remove();
      continue;
    }
    el.setAttribute('type', 'module');
  }

  // Strip every URL-bearing attribute that points anywhere external. We
  // also strip relative paths because the iframe loads from `about:srcdoc`,
  // where relative URLs resolve to nothing useful — leaving them in just
  // produces broken-image icons and confuses the reader.
  const all = doc.querySelectorAll('*');
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i];
    const isAnchor = el.tagName.toLowerCase() === 'a';
    for (const attr of URL_ATTRIBUTES) {
      if (!el.hasAttribute(attr)) continue;
      const value = el.getAttribute(attr) ?? '';
      // An anchor that deep-links to a KB node keeps its href — the runtime
      // intercepts the click and routes navigation through the parent (see
      // the nav-bridge script in `buildSandboxedHtml`).
      if (isAnchor && attr === 'href' && isInternalNodeLink(value)) continue;
      if (!isAllowedUrl(value)) el.removeAttribute(attr);
    }
  }

  return doc.body.innerHTML;
}

/**
 * The Content-Security-Policy applied to the iframe document. Pinned in code
 * so the rules cannot drift between renderer and audit.
 *
 * - `default-src 'none'`         everything is denied unless explicitly allowed
 * - `script-src 'unsafe-inline'` only inline scripts (no src= loads)
 * - `style-src  'unsafe-inline'` only inline styles
 * - `img-src    data:`           only data: URIs (no remote pixels)
 * - `font-src   data:`           only data: URIs (no font CDNs)
 * - `connect-src 'none'`         no fetch/XHR/EventSource/WebSocket/sendBeacon
 * - `form-action 'none'`         forms cannot submit anywhere
 * - `base-uri    'none'`         <base> cannot redirect relative URLs
 * - `frame-src   'none'`         no nested iframes
 *
 * `frame-ancestors` is intentionally omitted — browsers ignore it when
 * delivered via `<meta>`, and the parent already chose to embed this iframe
 * by setting its `srcDoc`, so the directive would be redundant anyway.
 */
const CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ');

/**
 * Names exposed on `window.bevel` inside the iframe. Each name MUST be a
 * top-level identifier in the concatenated source, or the
 * `globalThis.bevel = {...}` literal throws `ReferenceError` and aborts before
 * assignment. Core inlines no library sources, so this is empty — the
 * enterprise build adds `buildGraph` (the KB-graph client's entry point) here
 * alongside its inlined d3/mermaid/graph-client sources.
 */
const BEVEL_GLOBAL_EXPORTS: string[] = [];

/**
 * Strip relative-path `import` statements between concatenated library files.
 * After concatenation every named symbol is in the same module scope, so the
 * imports are redundant — and they would otherwise re-declare bindings that
 * already exist (causing "Identifier already declared" parse errors).
 *
 * Handles both single-line and multi-line forms:
 *   import { Foo } from './bar.js';
 *   import {
 *     Foo,
 *     Bar,
 *   } from './baz.js';
 *   import './side-effect.js';
 *
 * `[^;]*?` is non-greedy and matches across newlines (the negated character
 * class includes `\n`), so the whole statement up to the terminating `;` is
 * consumed even when it spans multiple source lines.
 */
function stripRelativeImports(source: string): string {
  return source.replace(
    /^[ \t]*import\s[^;]*?['"]\.{1,2}\/[^'"\n]+['"][^;]*;?/gm,
    '',
  );
}

/**
 * Encode a string so it is safe to embed inside an HTML `<script>` tag body.
 * The only sequence we have to break is the literal `</script>` (or
 * variants), which would otherwise close the script element early — even
 * when the literal sits inside a JS string.
 *
 * Escaping the slash inside the closing tag preserves the JS source
 * semantics (string contents are unchanged after JS parsing) while
 * preventing the HTML tokenizer from finishing the script element.
 */
function escapeForScriptBody(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * Runtime appended to the iframe's inline module so agent HTML can deep-link
 * into the knowledge graph. The iframe is sandboxed without
 * `allow-top-navigation`, so it can't navigate the host window itself — any
 * attempt throws "Unsafe attempt to initiate navigation … sandboxed …". Instead
 * we hand the target to the parent via `postMessage`; the parent
 * (`HtmlRenderer` / the embed) decides whether and how to navigate.
 *
 * Two entry points:
 *   - `window.bevel.openNode(href)` — for programmatic viewers (e.g. a d3 graph
 *     whose node `click` handler wants to open the underlying node).
 *   - A delegated click listener on `<a href>` — for plain HTML links. Pure
 *     in-page anchors (`#…`) are left alone so they still scroll the document.
 */
const NAV_BRIDGE = `
;(function () {
  function navigate(target) {
    if (typeof target !== 'string' || target === '') return;
    parent.postMessage({ type: 'bevel.navigate', href: target }, '*');
  }
  globalThis.bevel.openNode = navigate;
  globalThis.bevel.navigate = navigate;
  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
      var el = e.target;
      var a = el && el.closest ? el.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#') return;
      e.preventDefault();
      navigate(href);
    });
  }
})();
`;

interface BuildSandboxedHtmlOptions {
  /** Display title (rendered in the iframe doc's <title>). */
  title: string;
  /** knowledge-base JS library files, in dependency order. */
  libModuleSources: string[];
  /**
   * Emit the runtime (library + nav bridge)? The EMAIL viewer passes false:
   * its frame is mounted `sandbox=""`, so a script could never run, and
   * shipping one anyway leaves dead code in a document whose whole claim is
   * that it executes nothing.
   */
  includeRuntime?: boolean;
  /** Sanitized agent HTML, body content only. */
  bodyHtml: string;
}

/**
 * Bundle the inlined library + sanitized agent body into a complete HTML
 * document suitable for `<iframe srcDoc>`. The output makes zero network
 * requests: the library is inlined, the CSP forbids outbound fetches, and
 * the sanitizer has already stripped any external URLs from the body.
 */
export function buildSandboxedHtml(opts: BuildSandboxedHtmlOptions): string {
  const lib = opts.libModuleSources.map(stripRelativeImports).join('\n\n');
  const exposeGlobals = `\n;globalThis.bevel = { ${BEVEL_GLOBAL_EXPORTS.join(', ')} };\n`;
  const inlineLib = escapeForScriptBody(lib + exposeGlobals + NAV_BRIDGE);

  // Title and body are content-only — `srcDoc` already isolates them, but we
  // still want to escape the few characters that would terminate the parent
  // attribute or the script element early.
  const safeTitle = opts.title.replace(/[<>&"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP_DIRECTIVES}">
<meta name="referrer" content="no-referrer">
<title>${safeTitle}</title>
</head>
<body>
${opts.includeRuntime === false ? '' : `<script type="module">
${inlineLib}
</script>`}
${opts.bodyHtml}
</body>
</html>`;
}
