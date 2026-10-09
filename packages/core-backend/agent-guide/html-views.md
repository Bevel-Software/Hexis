## HTML views

An `.html` (or `.htm`) file in the knowledge base is a live page: the app shows
it in a sandboxed frame, scripts and all. Write one when a reader is better
served by something interactive — a dashboard, a filterable table, a chart —
than by a markdown document.

### The frame

- **No network.** The page cannot fetch, load or send anything: no `fetch`, no
  XHR, no WebSocket, no external script, stylesheet, font or image. Put the
  data the page shows into the page itself.
- **Inline scripts and styles only.** `<script src>`, `<link>`, `<iframe>`,
  `<object>`, `<embed>`, `<base>` and `<meta>` are removed. Write CSS in a
  `<style>` element and code in an inline `<script>`. An image is a `data:`
  URL.
- **Scripts run as ES modules**, in source order, after the document is
  parsed: `document.getElementById` works without waiting for
  `DOMContentLoaded`, top-level `await` works, and a top-level declaration is
  local to its script, not a global.
- **No browser storage.** `localStorage`, `sessionStorage`, IndexedDB and
  cookies are unavailable; a page keeps no state between views.
- **No host navigation.** The page cannot navigate the app, open a window or
  submit a form. Links reach the app through the bridge below.
- **`window.bevel` exists only in the app.** Opened anywhere else, the page has
  no bridge; guard a call with `window.bevel?.openNode`.

### `window.bevel`

Core puts two members on it:

- `window.bevel.openNode(href)` — follow `href` as if the reader had clicked a
  link to it.
- `window.bevel.navigate(href)` — the same function under a second name.

A distribution may add data members of its own to `window.bevel`; its own
section of this guide names them. Do not call a member this guide does not
name.

### Links written in the markup

An `<a href>` in the page keeps its address only when it is one of these:

- a document of the knowledge base, `.md`, `.html` or `.htm`, with or without a heading — `../Knowledge/Alice.md#goal`, `Q3-Report.html`, `Notes.htm`
- an absolute workspace URL — `/workspace/main/{{knowledgeBaseDir}}/Alice.md`
- an external address — `https://example.com/docs`, `http://example.com`, `mailto:team@example.com`
- a bare fragment, a place in this page — `#totals`, `#`

Every other address is removed from the link when the page is shown, and the
link goes nowhere:

- any other scheme — `javascript:alert(1)`, `data:text/html,hi`, `file:///etc/hosts`, `tel:+15550100`
- a protocol-relative address — `//cdn.example.com/lib.js`
- a relative path to anything else — `data.csv`, `../Images/chart.png`

### How a link resolves

The same rules apply to a click on a link and to `window.bevel.openNode(href)`
or `window.bevel.navigate(href)`:

- **A bare fragment scrolls the page.** `#totals` scrolls the element with
  `id="totals"` into view inside the frame; the page stays loaded and the app
  does not move. A fragment that names no element by `id`, and no `<a name>`,
  does nothing. `#` and `#top` scroll to the top of the page only when no
  target matches: an element with `id="top"`, or an `<a name="top">`, wins
  over the top of the page. Use this for a table of contents or a "back to
  top" link. The page's own address does not change, so `hashchange` never
  fires: a page that routes by hash handles its own clicks.
- **A relative path** resolves against the folder of the page's own file and
  opens that file in the app: from `{{knowledgeBaseDir}}/Reports/Q3.html`,
  `../Knowledge/Alice.md#goal` opens `{{knowledgeBaseDir}}/Knowledge/Alice.md`
  at its `goal` heading.
- **`/workspace/<branch>/<path>`** opens that file on that branch.
- **An external address** (`http:`, `https:`, `mailto:`) opens in a new tab.
  A call from a script may also open `tel:`, `sms:`, `geo:` and a
  protocol-relative `//host/path` address in a new tab, though a link
  written in the markup cannot keep one.
- **Anything else** (`javascript:`, `data:`, `file:`, an empty string) does
  nothing.

A click that a handler of the page has already cancelled with
`event.preventDefault()` is left to that handler: the bridge neither scrolls
nor opens anything for it.
