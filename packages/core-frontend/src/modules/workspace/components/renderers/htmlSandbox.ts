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
 *      An `<a href>` is the one exception, because a link is not a resource
 *      the document loads — it is an address the READER may choose to follow,
 *      and the parent, not the iframe, is what follows it. So a link to
 *      another document of the knowledge base, or to an `http:`, `https:` or
 *      `mailto:` address, keeps its href and reaches the parent through the
 *      nav bridge; see `isKeptLink`. Every other address is still removed.
 *
 *   2. `buildSandboxedHtml` — wraps the sanitized body and the inlined
 *      knowledge-base JS library into a complete HTML document with the
 *      strict CSP and a single inline `<script type="module">` containing
 *      the library code (so `window.bevel.buildGraph()` is callable from
 *      the agent's own scripts).
 */

import { isPageLinkExternalHref, normalizeHref } from '../../../../shared/markdown/hrefs';

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
 *
 * This governs every URL-bearing attribute EXCEPT an anchor's `href`, which
 * is a destination rather than a resource and has its own rule in
 * {@link isKeptLink}. In particular a `data:image/*` href is NOT a picture
 * the document shows, it is an address a click would try to open, so an
 * anchor does not get this allowance.
 */
function isAllowedUrl(rawUrl: string): boolean {
  const url = rawUrl.trim().toLowerCase();
  if (url === '') return true;
  if (url.startsWith('#')) return true;
  if (url.startsWith('data:image/')) return true;
  return false;
}

/** The scheme of a URL (`https:`), lower-cased, or null when it has none. */
function schemeOf(url: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:/i.exec(url);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Decide whether an `<a href>` written in the page's markup keeps its address.
 * Three shapes survive:
 *
 *   - another document of the knowledge base — a `.md`, `.html` or `.htm`
 *     path, with an optional `#heading` (`../Reports/Q3.html#totals`);
 *   - an absolute `/workspace/<branch>/<path>` citation URL;
 *   - an external `http:`, `https:` or `mailto:` address, per
 *     {@link isPageLinkExternalHref}.
 *
 * Everything else loses its href: any other scheme (`javascript:`, `data:`,
 * `file:`, `vbscript:`, an app's own `x-foo:`), protocol-relative `//host`,
 * and any other relative path — the iframe loads from `about:srcdoc`, where a
 * relative URL resolves to nothing the browser can fetch.
 *
 * A kept link is never followed by the browser: the sandbox forbids
 * navigating the top window, so the nav bridge in `buildSandboxedHtml` cancels
 * the click and hands the address to the parent, which resolves a document
 * against this page's own folder and opens an external address in a new tab
 * (`noopener,noreferrer`). This predicate is one of two gates on that path —
 * the other is `isOpenableExternalHref`, which guards the bridge against the
 * strings a page's SCRIPT can post without any anchor at all.
 *
 * The href is read through {@link normalizeHref}, the same rule the nav bridge
 * and the parent's resolver apply, so the string judged here is the string
 * followed: a padded `'  Board.html  '` is kept AND resolves against the
 * page's folder as `Board.html`, rather than becoming a filename with spaces
 * in it. HTML entities are already decoded by the time we see the value — it
 * comes out of `getAttribute`, past the parser.
 */
function isKeptLink(rawUrl: string): boolean {
  const url = normalizeHref(rawUrl);
  if (url === '') return true; // an anchor with nowhere to go; nothing to strip
  if (url.startsWith('#')) return true; // a section of this same page
  if (url.startsWith('//')) return false; // protocol-relative
  if (schemeOf(url)) return isPageLinkExternalHref(url);
  if (url.startsWith('/workspace/')) return true;
  return /\.(?:md|html|htm)(?:#|$)/i.test(url);
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
      // An anchor's `href` is a destination, not a resource, so `isKeptLink`
      // decides it ALONE — not as an exception layered on top of
      // `isAllowedUrl`. It keeps a link to another document of the knowledge
      // base or to an allowed external address (the runtime intercepts the
      // click and routes it through the parent — see the nav-bridge script in
      // `buildSandboxedHtml`), and it is stricter than `isAllowedUrl` about
      // `data:image/*`, which is a picture an `<img>` may show and not an
      // address a reader may be sent to.
      if (isAnchor && attr === 'href') {
        if (!isKeptLink(value)) el.removeAttribute(attr);
        continue;
      }
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
 *   - `window.bevel.openNode(href)` (and its alias `window.bevel.navigate`) —
 *     for programmatic viewers (e.g. a d3 graph whose node `click` handler
 *     wants to open the underlying node).
 *   - A delegated click listener on `<a href>` — for plain HTML links.
 *
 * A bare fragment (`#totals`) is the one address the bridge keeps to itself,
 * by either route: it scrolls the element with that id into view inside the
 * frame and posts nothing. The browser cannot be left to do it — a `srcdoc`
 * frame resolves `#totals` against the APP's URL, so the default action
 * navigates the frame away and unloads the page. A fragment naming no element
 * does nothing, except `#` and `#top`, which scroll to the top as a browser
 * would. A click whose default a handler of the page already cancelled is
 * left to that handler. The `html-views` section of the agent guide states this rule, and
 * `htmlViewsGuide.test.ts` holds the two together.
 */
const NAV_BRIDGE = `
;(function () {
  // A written href is read the way a browser reads it before the bridge
  // decides anything — the same rule as \`normalizeHref\` in the parent, kept
  // here in ES5 because this source is a string injected into the iframe and
  // cannot import. Without it a padded '  #goal  ' would be posted to the
  // parent instead of scrolled to here.
  function normalize(url) {
    var s = url.replace(/[\\t\\n\\r]/g, '');
    var start = 0;
    var end = s.length;
    while (start < end && s.charCodeAt(start) <= 0x20) start++;
    while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
    return s.slice(start, end);
  }
  function findTarget(id) {
    if (id === '') return null;
    var el = document.getElementById(id);
    if (el) return el;
    // The standard's fallback is the first <a name="…"> — an anchor, and only
    // an anchor. A form control's name is not a fragment target: a browser
    // leaves '#query' alone when only <input name="query"> carries it.
    var named = document.getElementsByName ? document.getElementsByName(id) : null;
    for (var i = 0; named && i < named.length; i++) {
      if (named[i].tagName && named[i].tagName.toUpperCase() === 'A') return named[i];
    }
    return null;
  }
  // A bare fragment is an in-page jump, scrolled here inside the frame. The
  // target is found as the HTML standard finds it: the fragment as written
  // first, its percent-decoding only when that names nothing.
  function jumpTo(fragment) {
    if (typeof document === 'undefined') return;
    var id = fragment.slice(1);
    var el = findTarget(id);
    if (!el) {
      var decoded = id;
      try {
        decoded = decodeURIComponent(id);
      } catch (err) {
        decoded = id;
      }
      if (decoded !== id) el = findTarget(decoded);
    }
    if (el) {
      el.scrollIntoView();
      return;
    }
    if (id === '' || id.toLowerCase() === 'top') globalThis.scrollTo(0, 0);
  }
  function navigate(target) {
    if (typeof target !== 'string') return;
    var href = normalize(target);
    if (href === '') return;
    if (href.charAt(0) === '#') {
      jumpTo(href);
      return;
    }
    parent.postMessage({ type: 'bevel.navigate', href: target }, '*');
  }
  globalThis.bevel.openNode = navigate;
  globalThis.bevel.navigate = navigate;
  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
      var el = e.target;
      var a = el && el.closest ? el.closest('a[href]') : null;
      if (!a) return;
      // A handler of the page's own that already cancelled this click owns
      // it (a toggle, a hash router); the bridge stays out of its way.
      if (e.defaultPrevented) return;
      // Cancelled even when there is nowhere to go: left to the browser, an
      // empty href reloads the frame against the app's URL, as '#…' would.
      e.preventDefault();
      var href = normalize(a.getAttribute('href') || '');
      if (!href) return;
      navigate(href);
    });
  }
})();
`;

/**
 * Runtime appended after the nav bridge so the parent can size the frame to
 * the page. The frame is sandboxed without `allow-same-origin`, so the parent
 * cannot measure the document itself; the page tells it instead, posting
 * `bevel.height` with the content's height whenever that changes — at load,
 * and on every resize the frame's own \`ResizeObserver\` sees. The parent
 * decides what to do with it: in the app the frame keeps its pane and the
 * message is ignored; on a surface whose host grows with the content
 * (`RendererSurface.sizesToContent`, the issue panel), the parent sets the
 * frame's height to it so the page is shown whole. A height is posted once
 * per value: a page that does not change says nothing twice.
 *
 * The height is the CONTENT's extent — the lowest edge of everything in
 * the body, text written straight into it included, plus the body's own
 * bottom padding and margin — never the document's \`scrollHeight\`. That
 * one is the greater of the content and the viewport, and the viewport is
 * whatever the parent just set the frame to, so measuring it feeds the
 * frame's height back as the page's: a page that got shorter could never
 * report less, and a frame whose viewport runs a border short of its height
 * would shrink by that border on every report until the page collapsed.
 * The content's extent is the root element's box with its height, and the
 * body's, left to the content: the body's margin box, which ends after
 * the last LINE box (text written straight into the body reaches it — the
 * body always has an element child, this very script, so counting
 * elements alone would measure such a page as empty, and a range over
 * text gives the inline boxes, which end above the line box when the line
 * is taller than the type) and after whatever bottom margin the last
 * child collapsed through the body. A page that sizes its root or body to
 * the viewport (\`height: 100%\`) would hand the frame's height back, so
 * the measurement forces both heights to auto for its own duration — an
 * inline declaration set and removed within one task, which no frame is
 * painted between and no observer sees, with the page's own inline
 * heights put back exactly. Nothing is added to the page: a marker element
 * would change what \`:last-child\` names and give a flex or grid body one
 * more item. The children's own edges union in besides, for a box out of
 * the flow.
 *
 * One thing no forcing reaches: a length in viewport units (\`100vh\`,
 * \`200vh\`), which is the frame's height whatever the page's boxes do.
 * Sized to such a report, the frame IS the viewport, so the page would
 * measure taller on every round trip — by its margins at \`100vh\`, by
 * double at \`200vh\` — and the frame would never settle; a page that moves
 * less than the viewport does (\`50vh\`) settles on its own. So a report is
 * held back when the page's height moved at least as far as the viewport
 * did, the same way, since the last measurement: that page is sized to
 * the frame, not to its content, and the frame stays where it is. Against
 * the last MEASUREMENT, posted or held: judged against the last post, a
 * held height would be posted at the next tick and the growth resume.
 */
const HEIGHT_BRIDGE = `
;(function () {
  if (typeof document === 'undefined' || !document.documentElement) return;
  var last = -1;
  /** Leave an element's height to its content for a measurement; returns what puts the page's own back. */
  function unsize(el) {
    var style = el.style;
    if (!style || typeof style.setProperty !== 'function') return function () {};
    var hadAttribute = typeof el.hasAttribute === 'function' ? el.hasAttribute('style') : true;
    var own = { height: style.getPropertyValue('height'), heightPriority: style.getPropertyPriority('height'),
                min: style.getPropertyValue('min-height'), minPriority: style.getPropertyPriority('min-height') };
    style.setProperty('height', 'auto', 'important');
    style.setProperty('min-height', '0', 'important');
    return function restore() {
      if (own.height) style.setProperty('height', own.height, own.heightPriority); else style.removeProperty('height');
      if (own.min) style.setProperty('min-height', own.min, own.minPriority); else style.removeProperty('min-height');
      // A page that wrote no style attribute gets none: removing the last
      // declaration leaves an empty attribute behind, which is not as
      // written. The attribute is written from the declarations lazily, on
      // the next read of it, so it is read once first — removed before
      // that, it would come back empty the moment anything looked.
      if (!hadAttribute && typeof el.removeAttribute === 'function') {
        el.getAttribute('style');
        el.removeAttribute('style');
      }
    };
  }
  /** The root's box with its height, and the body's, left to the content — the body's margin box. */
  function contentEnd(root, body) {
    var restoreRoot = unsize(root);
    var restoreBody = unsize(body);
    var bottom = root.getBoundingClientRect().bottom;
    restoreBody();
    restoreRoot();
    return bottom;
  }
  function measure() {
    var root = document.documentElement;
    var body = document.body;
    if (!body || typeof root.getBoundingClientRect !== 'function') {
      return root.scrollHeight || 0;
    }
    var bottom = contentEnd(root, body);
    var kids = body.children || [];
    for (var i = 0; i < kids.length; i++) {
      var edge = kids[i].getBoundingClientRect().bottom;
      if (edge > bottom) bottom = edge;
    }
    return bottom + (window.pageYOffset || 0);
  }
  var measuredHeight = -1;
  var measuredViewport = -1;
  function report() {
    var height = Math.ceil(measure());
    var viewport = window.innerHeight || 0;
    if (!isFinite(height) || height < 0) return;
    var dv = viewport - measuredViewport;
    var dh = height - measuredHeight;
    var changed = height !== measuredHeight;
    // Moved with the viewport, at least as far and the same way: sized to
    // the frame, not to its content.
    var withViewport = measuredHeight >= 0 && dv !== 0 && (dh > 0) === (dv > 0) && Math.abs(dh) >= Math.abs(dv) - 1;
    measuredHeight = height;
    measuredViewport = viewport;
    if (!changed || withViewport || height === last) return;
    last = height;
    parent.postMessage({ type: 'bevel.height', height: height }, '*');
  }
  if (typeof ResizeObserver === 'function') {
    var observer = new ResizeObserver(report);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  }
  if (typeof addEventListener === 'function') {
    addEventListener('load', report);
    // The frame's own resize: the root's and the body's boxes keep their
    // size when the frame grows around them, so the observer above does
    // not see it, and the viewport the next measurement is judged against
    // must be the new one — or a change that came with the frame's growth
    // would be read as growth with the viewport.
    addEventListener('resize', report);
  }
  report();
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
  const inlineLib = escapeForScriptBody(lib + exposeGlobals + NAV_BRIDGE + HEIGHT_BRIDGE);

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
