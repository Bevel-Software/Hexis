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

On the app's file page, a page calls the tools of the person viewing it —
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
embed, on a skill page and in any preview that is not the app's file page.
Check it before every use, and render the page without tools when it is
`null` — never assume it is there:

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
resolves `true` at once, with nothing shown, on the app's file page. Anywhere
else the app shows a card, "<page name> uses tools that are only available in
the platform", with Continue without tools and Open in the platform; Open in
the platform opens the page on the app's file page (in a new tab when the page
is shown on another site). Either way the call resolves `false`, and the page
goes on rendering without tools:

```js
if (await window.bevel?.requireTools?.()) {
  // window.bevel.tools is there
}
```

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
  opens that file in the app, in a new tab, leaving the page where it is:
  from `{{knowledgeBaseDir}}/Reports/Q3.html`, `../Knowledge/Alice.md#goal`
  opens `{{knowledgeBaseDir}}/Knowledge/Alice.md` at its `goal` heading. A
  path that names the page's own file with a fragment (`Q3.html#totals`
  from `Q3.html`) scrolls the page, as `#totals` does.
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
