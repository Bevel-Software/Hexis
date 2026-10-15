/**
 * The navigation runtime every HTML knowledge view runs, as source text: the
 * app's sandboxed frame (core-frontend `htmlSandbox.ts`) and the local MCP
 * server's knowledge views (hexis-mcp `views/bridge.ts`) inject this same
 * string, so `window.bevel.openNode` / `navigate`, an anchor click and a bare
 * fragment behave the same wherever a view is shown.
 *
 * It expects `globalThis.bevel` to exist, and posts `{ type: 'bevel.navigate',
 * href }` to `parent` for every destination it does not keep to itself.
 */

/**
 * Runtime appended to the iframe's inline module so agent HTML can deep-link
 * into the knowledge graph. The iframe is sandboxed without
 * `allow-top-navigation`, so it can't navigate the host window itself — any
 * attempt throws "Unsafe attempt to initiate navigation … sandboxed …". Instead
 * we hand the target to the parent via `postMessage`; the parent
 * (`HtmlRenderer` / the embed) decides whether and how to navigate. The local
 * MCP server's knowledge views (hexis-mcp) run this same source, with their
 * own bridge standing in for `parent`.
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
export const HTML_NAV_BRIDGE = `
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
