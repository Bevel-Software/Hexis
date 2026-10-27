## HTML views

An `.html` (or `.htm`) file in the knowledge base is a live page: the app shows
it in a sandboxed frame, scripts and all. Write one when a reader is better
served by something interactive — a dashboard, a filterable table, a chart —
than by a markdown document.

### The frame

- **No network.** The page cannot fetch, load or send anything: no `fetch`, no
  XHR, no WebSocket, no external script, stylesheet, font or image. Put the
  data the page shows into the page itself, or read it through
  `window.bevel.tools` where the app offers it (below).
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

Core puts four members on it:

- `window.bevel.openNode(href)` — follow `href` as if the reader had clicked a
  link to it.
- `window.bevel.navigate(href)` — the same function under a second name.
- `window.bevel.tools` — the viewer's tools, or `null` where there are none
  (next section).
- `window.bevel.requireTools()` — ask for the tools when the page cannot work
  without them (next section).

A distribution may add data members of its own to `window.bevel`; its own
section of this guide names them. Do not call a member this guide does not
name.

### Calling tools: `window.bevel.tools`

On the app's file page, and on a skill's page in the Library (Skills & Tools →
the skill → its file), a page calls the tools of the person viewing it —
exactly the tools that person's own agent gets from the hosted MCP server,
with the same names, answers and refusals — through five functions, each
returning a promise:

- `window.bevel.tools.searchTools(query)` — `{ tools: [names] }`: what
  `list_tools` lists, narrowed to the names containing every word of `query`
  (`''` lists them all).
- `window.bevel.tools.toolsInfo(names)` — what `tools_info` answers for an
  array of tool names: their TypeScript interfaces.
- `window.bevel.tools.callTool(name, args)` — what `tools/call` answers:
  `name` is the tool's name as an agent calls it (`read_file`), `args` its
  arguments. A tool's error, or a refusal (a file the viewer may not read),
  rejects the promise with the tool's own message.
- `window.bevel.tools.callToolChain(code)` — what `call_tool_chain` answers
  for `code`.
- `window.bevel.tools.uploadFile(file, options)` — what `apply_file_upload`
  answers after the app has uploaded `file` for the viewer (below).

The two kinds of name differ. `searchTools` and `toolsInfo` use the
namespaced name a chain calls (`KNOWLEDGE_BASE.read_file`, `notion.search`);
`callTool` takes the name `tools/call` takes: a knowledge-base tool bare
(`read_file`), any other tool with its dots as underscores
(`notion_search`). Passing a `searchTools` result straight to `callTool`
fails as an unknown tool — convert it, or call it from `callToolChain`.

`window.bevel.tools` is `null` wherever tools are not available: on the
embed (a page shown on another site, or in a chat's MCP App pane), and in a
change request's or a file history's preview of a page. Check it before
every use, and render the page without tools when it is `null` — never
assume it is there:

```js
const tools = window.bevel?.tools;
if (tools) {
  const file = await tools.callTool('read_file', { body: { branch: 'main', path: '{{knowledgeBaseDir}}/Foo.md' } });
  // …show it
} else {
  // …render without it
}
```

**Reading runs at once; writing asks first.** A call to a tool that only
reads runs with no prompt. The first call that may write — to a tool the
deployment tags as writing (`edit_file`, `write_file`, …), to a tool of a
`.tool` manual or a plugin's MCP server (nothing says those only read), or
any `callToolChain` — makes the app show the viewer one card, "<page name>
wants to write to the knowledge base", with the page's path under it and
Allow while open and Deny. Allow runs the call, and every later writing call
of the page runs without asking again until the page is reloaded. Deny runs
nothing and rejects the call with `denied` (`error.message` and
`error.code` are both `'denied'`); the next writing call asks again. The card
is the app's, outside the frame: the page cannot draw, dismiss or answer it.
Every call a page makes is recorded in the Audit log under the viewer, with
the page's path as the agent; a denied call is recorded as refused.

**Putting a file in: `uploadFile`.** `write_file` carries text only, so a
spreadsheet, a document, an image or a zip the viewer picks goes in through
`uploadFile(file, { branch, destination, mode })`. `file` is a `File` (from an
`<input type="file">` or a drop) or a `Blob` with a `name` option; `branch`
and `destination`, the folder it lands in, are required; `mode` is `create`
(the default), `overwrite` or `update`, with `write_file`'s meaning. The app
does what an agent does, as the viewer: `request_file_upload`, the bytes sent
to the upload address, `apply_file_upload`. The file lands under its own name
with its bytes unchanged, and a zip lands as its entries. The promise resolves
with `apply_file_upload`'s answer, `{ destination, count, total, files }`,
`files` naming every path (a zip's every entry) with its outcome, and
rejects with the refusal: a file over the deployment's upload limit (the
message names it), a destination the viewer may not write, or, when nothing
landed, the first path's refusal, with its code in `error.code` (`exists`
under `create`, `missing` under `update`). A refused upload writes nothing,
and the bytes it sent are deleted at once. An upload is a writing call: the
first one shows the card above, and Allow while open covers it and every
later upload and writing call of the page view. The upload's token stays in
the app; the page never sees it.

```js
const input = document.getElementById('briefing');
input.addEventListener('change', async () => {
  const answer = await window.bevel.tools.uploadFile(input.files[0], {
    branch: 'main',
    destination: '{{knowledgeBaseDir}}/Campaigns/Easter',
  });
  // answer.files[0].path is where it landed
});
```

**A page that needs tools asks for them.** `window.bevel.requireTools()`
resolves `true` at once, with nothing shown, on the app's file page and on a
skill's page. Anywhere else the app shows a card,
"<page name> uses tools that are only available in the platform", with
Continue without tools and Open in the platform; Open in the platform opens
the page on the app's file page (in a new tab when the page is shown on
another site). Either way the call resolves `false`, and the page
goes on rendering without tools:

```js
if (await window.bevel?.requireTools?.()) {
  // window.bevel.tools is there
}
```

### Live data: a page that stays still while it loads

A page that reads its data through `window.bevel.tools` waits on several
calls before it has anything to show. Write it so the reader never sees the
page change shape, never sees a half-loaded board as if it were the answer,
and never loses the board they were reading:

- **Render the final page shell in the markup, before any data.** Headings,
  columns, panels and the controls are in the HTML itself, with their size
  reserved in CSS (a grid, a `min-height` per region). The loading treatment —
  placeholder rows, `aria-busy="true"` — sits **inside** the data regions.
  Never start with one "Loading…" line that the script later swaps for the
  whole page: that swap is a full-page layout change, and the first thing the
  reader sees looks broken.
- **Publish one consistent dataset at a time.** Collect every read into local
  variables first; when ALL of them have succeeded, update every data region
  from that one dataset in one synchronous step. Until then show no counts,
  no cards and no empty columns: "0" or "None" is an answer only a finished
  dataset may give.
- **Refresh keeps the current board.** A refresh leaves the last published
  dataset on screen, shows a small refreshing state (a status line, the
  Refresh button disabled) and publishes the replacement only when it is
  complete. Never return to the loading placeholders.
- **A failed read fails the whole load, visibly.** If any read the page needs
  rejects, publish nothing from that load: keep the shell (first load) or the
  last good dataset (refresh), say what failed — the rejection carries the
  tool's own message — and offer a Retry button that runs the same load
  again. Never show the reads that did succeed as if they were the whole
  board.
- **Read in bounded parallel once the paths are known.** List first
  (`list_files`, `grep`), then read the files it named with a small fixed
  number of `callTool` reads in flight at a time — four is plenty — rather
  than one after another or all at once. Read tools run at once with no
  prompt.
- **Load with `callTool`, not `callToolChain`.** A chain may write, so the app
  asks the viewer before it runs: a page that loads through `callToolChain`
  shows its reader a "wants to write" card for a read.
- **The reads are the viewer's own.** Every call answers with exactly what
  the person viewing the page may read: `list_files` and `grep` leave out
  what they may not, and `read_file` of such a file rejects. Build the board
  from what the calls return; never try to widen it (another identity, a
  copied dataset) — the same page shows each reader their own board.
- **Link to what the tools named by the path they answered.** A path a tool
  answers (`read_file`'s `path`, a listing's `path`) starts with the checkout
  folder, `{{kbDirName}}/Data/Tickets/A.md`, and knows nothing of where the
  page sits. Link to it on the branch the page read it from,
  `'/workspace/' + encodeURIComponent(BRANCH) + '/' + path`, so a card and its
  data come from one branch; a root-relative `'/' + path` opens it on the
  branch the page is viewed on instead (see *How a link resolves*). Never
  put the checkout folder in front of a path a tool answered: it is already
  there.

A complete page that follows these rules — plain HTML and one inline script,
no build step and no framework:

```html
<!doctype html>
<html>
<head>
<style>
  body { font: 14px system-ui, sans-serif; margin: 16px; }
  header { display: flex; align-items: center; gap: 12px; min-height: 40px; }
  #status { color: #555; }
  #status.error { color: #b00020; }
  .board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .column { min-height: 320px; border: 1px solid #ddd; border-radius: 6px; padding: 8px; }
  .column ul { list-style: none; margin: 0; padding: 0; }
  .column li { min-height: 20px; padding: 6px; margin-bottom: 6px; border-radius: 4px; background: #f4f4f4; }
  .column li.placeholder { background: #ececec; }
  .count { color: #777; font-weight: normal; }
</style>
</head>
<body>
<header>
  <h1>Tickets</h1>
  <button id="refresh" type="button" disabled>Refresh</button>
  <span id="status" role="status">Loading…</span>
  <button id="retry" type="button" hidden>Retry</button>
</header>
<main id="board" class="board" aria-busy="true">
  <section class="column" data-status="todo"><h2>To do <span class="count"></span></h2><ul><li class="placeholder"></li><li class="placeholder"></li></ul></section>
  <section class="column" data-status="doing"><h2>Doing <span class="count"></span></h2><ul><li class="placeholder"></li><li class="placeholder"></li></ul></section>
  <section class="column" data-status="done"><h2>Done <span class="count"></span></h2><ul><li class="placeholder"></li><li class="placeholder"></li></ul></section>
</main>
<script>
  // The branch the page is published on: its data and its links both come
  // from there. A copy published on another branch sets it to that branch.
  const BRANCH = 'main';
  const FOLDER = 'Data/Tickets';
  const READS_IN_FLIGHT = 4;
  const tools = window.bevel?.tools;
  const board = document.getElementById('board');
  const statusLine = document.getElementById('status');
  const refreshButton = document.getElementById('refresh');
  const retryButton = document.getElementById('retry');
  let published = false;

  /** The text under `# <heading>` in a node's markdown, whatever its line endings. */
  function field(markdown, heading) {
    const lines = markdown.split(/\r?\n/);
    const at = lines.indexOf('# ' + heading);
    if (at < 0) return '';
    const end = lines.findIndex((line, i) => i > at && line.startsWith('# '));
    return lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim();
  }

  /**
   * `fn` over `items`, at most `limit` at a time. After a failure no new item
   * starts; it rejects with the first failure once the calls in flight have
   * settled, so a Retry never overlaps the load that failed.
   */
  async function mapBounded(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    let failure = null;
    async function worker() {
      while (!failure && next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i]);
        } catch (error) {
          failure ??= { error };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    if (failure) throw failure.error;
    return results;
  }

  /** The whole dataset, or a rejection. Touches no element. */
  async function readTickets() {
    const listing = await tools.callTool('list_files', { body: { branch: BRANCH, path: FOLDER } });
    const paths = listing.entries
      .filter((entry) => entry.type === 'file' && entry.name.endsWith('.md'))
      .map((entry) => `${FOLDER}/${entry.name}`);
    return mapBounded(paths, READS_IN_FLIGHT, async (path) => {
      const file = await tools.callTool('read_file', { body: { branch: BRANCH, path } });
      // `file.path` is the path as the tool names it, checkout folder first.
      return { path: file.path, name: field(file.content, 'Name') || path, status: field(file.content, 'Status').toLowerCase() };
    });
  }

  /** Every data region from one dataset, in one synchronous step. */
  function publish(tickets) {
    for (const column of board.querySelectorAll('.column')) {
      const mine = tickets.filter((ticket) => ticket.status === column.dataset.status);
      column.querySelector('.count').textContent = `(${mine.length})`;
      const items = mine.map((ticket) => {
        const link = document.createElement('a');
        link.href = '/workspace/' + encodeURIComponent(BRANCH) + '/' + ticket.path;
        link.textContent = ticket.name;
        const item = document.createElement('li');
        item.append(link);
        return item;
      });
      if (items.length === 0) {
        const none = document.createElement('li');
        none.textContent = 'None';
        items.push(none);
      }
      column.querySelector('ul').replaceChildren(...items);
    }
    published = true;
  }

  async function load() {
    refreshButton.disabled = true;
    retryButton.hidden = true;
    board.setAttribute('aria-busy', 'true');
    statusLine.className = '';
    statusLine.textContent = published ? 'Refreshing…' : 'Loading…';
    try {
      publish(await readTickets());
      statusLine.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      statusLine.className = 'error';
      statusLine.textContent = (published ? 'Could not refresh; showing the last loaded board. ' : 'Could not load the tickets. ') + error.message;
      retryButton.hidden = false;
    } finally {
      board.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', load);
  retryButton.addEventListener('click', load);
  if (tools) {
    load();
  } else {
    board.setAttribute('aria-busy', 'false');
    statusLine.textContent = 'Open this page in Bevel to load the tickets.';
  }
</script>
</body>
</html>
```

### Links written in the markup

An `<a href>` in the page keeps its address only when it is one of these:

- a document of the knowledge base, `.md`, `.html` or `.htm`, with or without a heading — `../Knowledge/Alice.md#goal`, `Q3-Report.html`, `Notes.htm`
- a root-relative path to such a document, from the checkout folder — `/{{kbDirName}}/Data/Tickets/A.md`
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
  opens that file in the app, in a new tab, leaving the page where it is:
  from `{{knowledgeBaseDir}}/Reports/Q3.html`, `../Knowledge/Alice.md#goal`
  opens `{{knowledgeBaseDir}}/Knowledge/Alice.md` at its `goal` heading. A
  path that names the page's own file with a fragment (`Q3.html#totals`
  from `Q3.html`) scrolls the page, as `#totals` does.
- **A root-relative path**, `/{{kbDirName}}/<path>`, opens that file on the
  page's own branch, in a new tab, from a page in any folder: the form for a
  path a tool answered (`list_files`, `grep`), which is a path from the
  checkout folder and knows nothing of where the page sits. A link the page's
  script creates after load is kept as written, so `a.href = '/{{kbDirName}}/'
  + path` is enough.
- **`/workspace/<branch>/<path>`** opens that file on that branch, in a new
  tab.
- **An external address** (`http:`, `https:`, `mailto:`) opens in a new tab.
  A call from a script may also open `tel:`, `sms:`, `geo:` and a
  protocol-relative `//host/path` address in a new tab, though a link
  written in the markup cannot keep one.
- **Anything else** (`javascript:`, `data:`, `file:`, an empty string) does
  nothing.

A click that a handler of the page has already cancelled with
`event.preventDefault()` is left to that handler: the bridge neither scrolls
nor opens anything for it.

A click on a link with Ctrl, Cmd or Shift held, or with the middle button,
opens its destination in a new tab, as a browser does with a link: a bare
fragment opens the page's own file at that section in a new tab, and the
page stays where it is.
