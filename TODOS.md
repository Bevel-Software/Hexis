# TODOS

## Knowledge rendering

### Serve a file at a git ref so change-request screenshots render in the diff

**What:** `?ref=<sha>` on `GET /workspace/:id/file/raw`, backed by a Buffer variant of `readFileAtRef` (`git.service.ts` returns a string today), sha validation like the existing show-file path, and a read gate for bytes at arbitrary refs. Then `MarkdownDiffViewer` passes the CR head sha so removed and added fragments each resolve to their own revision.

**Why:** The change-request dialog and file history show a placeholder for every relative image, and a screenshot that exists only on the CR branch is invisible to reviewers except by opening the doc on that branch. Reviewers should see the before and after of a visual change inline. The same endpoint can replace `BinaryChangePlaceholder` with a real before/after preview.

**Context:** Deferred from the KB images PR (feat/kb-images) because at-ref byte serving deserves its own security review. Alternative considered and rejected: build the image URL with the CR branch's workspace id. It works today because `resolveWorkspaceDir` lazily clones a branch workspace per user, but that clones the whole KB on first open of a dialog, is never refreshed after later pushes to the CR branch, and evaluates the read gate against that clone. Start from the raw route, add `ref` parsing and validation, then reuse the per-fragment rule in `MarkdownDiffViewer` (unchanged and added fragments resolve, removed fragments placeholder) to pass the baseline sha to removed fragments and the head sha to added ones.

**Effort:** M
**Priority:** P2
**Depends on:** feat/kb-images (img override and the per-fragment rule)

### Paste or drop an image into the markdown editor

**What:** In the edit textarea of `MarkdownRenderer` (and the skill page editor), handle `paste` and `drop` events carrying an image: upload through the existing `uploadFile` to `<doc folder>/assets/<name>`, then insert `![<name>](./assets/<name>)` at the caret.

**Why:** Today an author saves a screenshot to disk, drops it into the right folder in the explorer, then types the link by hand. The documented convention (images live in `./assets/` next to the page) is only followed if the tool makes it the path of least resistance. Non-writers already land on the suggestions branch through the same upload route, so proposals with screenshots work without new plumbing.

**Context:** `uploadFile` commits as the user and fires `file-changed`; with the image-version hook from feat/kb-images the new image renders as soon as the link is inserted and the doc saved. Watch: caret insertion in a controlled textarea, file-name collisions (`image.png` twice, suffix with a timestamp or short hash), the autosave interaction (an upload mid-edit bumps `fsRevision`), and never clobbering a `pendingFileContent` review. Start in `MarkdownRenderer`'s textarea; `SkillFileEditor` second.

**Effort:** M
**Priority:** P2
**Depends on:** feat/kb-images (rendering and the README convention)

### Stream the raw route with res.sendFile once there is a measured reason

**What:** Switch `GET /workspace/:id/file/raw` from `readFileBinary` + `res.send` to `res.sendFile(abs, { dotfiles: 'allow', cacheControl: false, etag: true, lastModified: true, acceptRanges: true }, cb)` with a callback that maps ENOENT to 404 and traversal to 400, after a `workspaceService.resolveFilePath()` that lifts the traversal check out of `readFileBinary`. Rework both route harnesses (`workspace.routes.download.test.ts`, `workspace.routes.read-gate.test.ts`, which stub `readFileBinary`) to serve real temp files.

**Why:** Every revalidation of an image reads the whole file and sha1-hashes it for Express's weak ETag; a thirty-screenshot page costs thirty reads and hashes to send thirty 304s. `sendFile` answers 304 from a stat and streams large PDFs with Range support.

**Context:** Deferred from feat/kb-images on grounds of scale: uploads are capped at 50 MB (`MAX_UPLOAD_BYTES`). Trigger: a measured hot path on staging (server CPU or disk time on an image-heavy page), or PDFs large enough that Range matters. Two footguns: `dotfiles` defaults to `'ignore'`, which 404s every file under Loop's `.assets/`; and `sendFile` reports errors through its callback, not the route's try/catch. Set Content-Type before calling it so the custom MIME map and the svg octet-stream rule keep winning; Cache-Control stays ours via `cacheControl: false`.

**Effort:** M
**Priority:** P3
**Depends on:** feat/kb-images (the Cache-Control header lands there)

### Let agents in core create image files

**What:** Give core MCP agents a way to write binary image files into the KB: either port `request_upload_token` and `apply_upload` from the enterprise tool set into core, or accept base64 content in `write_file` for image extensions (png, jpg, jpeg, gif, webp) with a size cap.

**Why:** `write_file` is text-only and the upload-token tools exist only in enterprise, so an agent asked to "add the screenshot to the page" cannot, and an agent that spots missing knowledge cannot attach evidence. feat/kb-images adds a sentence to the tool descriptions telling agents where images go; this adds the ability to act on it.

**Context:** Base64 inflates payloads by a third and needs a hard cap; a ported upload-token flow is more code but streams and matches enterprise. Either way it is a new write surface for agents and belongs in its own review. Decide base64 versus upload token with the enterprise maintainers first. The MCP image-read allow-list (`image-read.ts`) is the natural allow-list for what agents may write.

**Effort:** M
**Priority:** P3
**Depends on:** feat/kb-images (rendering and the documented convention)

## Backend

### One extension-to-MIME table with per-consumer allow-lists

**What:** Replace three hand-maintained maps with one table in a shared module and three small allow-lists on top: the raw route's serve map in `workspace.routes.ts` (png, jpg, jpeg, gif, webp, svg, bmp, ico, pdf, docx, xlsx), the MCP image-read set in `image-read.ts` (png, jpg, jpeg, gif, webp, deliberately no svg), and the text-reader notice map `MIME_BY_EXT` in `text-reader.ts`, which names everything a text read refuses with a notice: the same images, archives (zip, gz, tar, 7z, rar), legacy Office (doc, ppt, xls), media (mp3, wav, mp4, mov), fonts (woff, woff2, ttf), pdf, wasm and exe. The frontend's `IMAGE_EXTENSIONS` in `useImageRevision.ts` is a fourth copy of the image subset.

**Why:** Same data, four copies, and each copy bakes its own policy into the map itself. The next format (avif, heic from phone screenshots) has to be added in four places or it silently works in one surface and not another.

**Context:** The svg difference is intentional and security-relevant: the raw route serves svg as `image/svg+xml` with a CSP sandbox for documents; the MCP reader treats it as text so an agent never receives active content as an image. The consolidation must preserve that split as an explicit allow-list, not an omission someone might "fix". Start with the shared module, port the raw route first (covered by `workspace.routes.download.test.ts`), then the MCP reader (covered by `workspace.tools.test.ts`).

**Effort:** S
**Priority:** P3
**Depends on:** None

## Agent instructions

### Automated eval harness for the header and tool prefix

**What:** A vitest file under core-backend, skipped unless an API key env var is set, that sends the composed instructions plus the tool list to the Claude API and asserts the first tool call for three fixed organisation-specific questions.

**Why:** The header is a prompt; prompts drift; nothing in CI notices. The manual eval in the agent-preamble change proves today's wording once; every later edit ships blind.

**Context:** The composer lives in `packages/core-backend/src/modules/agent-instructions/compose.ts`. The three baseline questions and their before/after results are recorded in the agent-preamble PR description; encode those as the fixtures. Decide how an API key reaches CI before writing the test.

**Effort:** M
**Priority:** P3
**Depends on:** The agent-preamble change landing.

### Echo the instructions from `start_session` as a third channel

**What:** Include `instructions` in the `start_session` result for external sessions, so a client that drops the handshake and truncates tool descriptions still receives the full preamble on its first call.

**Why:** After agent-preamble the model gets the full text through the handshake and a 300-character prefix on four tools. A client that ignores the handshake sees only the prefix.

**Context:** `start_session` is external-only at `packages/core-backend/src/modules/workspace/workspace.tools.ts:453`; the composer's result is available in-process in `McpService`. The earlier decision rejected this as the only channel because it arrives after the model decides to call; as a complement it is one field on an existing result. Build it only if the manual eval in the agent-preamble PR shows a client that needs it.

**Effort:** S
**Priority:** P3
**Depends on:** The agent-preamble change and its recorded eval results.

### Per-plugin instructions scoped by access

**What:** A per-plugin file (for example `Plugins/<Plugin>/agent-instructions.md`) appended to the composed text for callers who can read that plugin, under its own cap.

**Why:** Team-specific guidance today has no channel except the global preamble, which every agent sees.

**Context:** Turns the privileged broadcast into per-caller composition: the hosted proxy needs the caller's access resolution (`accessControl.canReadBatch`, see `tool-manuals.routes.ts:145`), and the composer needs a second layer with its own cap. Keep `composeAgentInstructions` pure so a wrapper can add the layer.

**Effort:** L
**Priority:** P3
**Depends on:** The agent-preamble change.

### Generated index of readable folders and ontologies

**What:** A composer extension point that appends a per-caller list of readable top-level folders (and, through the enterprise `CorePorts` seam, ontologies) under the admin text, within its own cap.

**Why:** Hand-written tables of contents go stale; the platform knows the tree and who may read it.

**Context:** The design of agent-preamble names this as the seam the enterprise overlay wants for graph-aware summaries. It is per-caller, so it builds on the per-plugin item above.

**Effort:** L
**Priority:** P4
**Depends on:** Per-plugin instructions scoped by access.

### Inline editing form for the preamble

**What:** A textarea on the "What connected agents are told" card that commits `mcp-description.md` as the admin, with live counts for both channels.

**Why:** Tuning a 300-character purpose sentence against a live counter is a better loop than editor, save, return, read.

**Context:** Precedent is the `roles.yaml` admin page. The Knowledge editor's commit path is the reference implementation; a second write path needs its own lock and conflict story. Build only on usage signal that admins tune the prefix often.

**Effort:** M
**Priority:** P4
**Depends on:** The agent-preamble change.

## hexis-mcp

### Verify the local-token "too old" check answers 404, not 401

**What:** Confirm what an older deployment answers for `POST /api/mcp/local-token` and align the message in `packages/hexis-mcp/src/oauth.ts:522-535`.

**Why:** The engineering review of agent-preamble verified that an unknown `/api/agent/*` path on an older deployment falls past the agent router into the JWT-protected mounts and answers 401, never 404. The local-token check assumes 404 to show its helpful "this deployment is too old for browser sign-in" message; if the same fall-through applies under `/api/mcp`, users see the generic "rejected the sign-in" error instead.

**Context:** MCP routes mount before the JWT mounts (`create-core-server.ts:267` and `:387`); an unknown sub-path under `/api/mcp` may still fall through. Reproduce with a config stub or an older deployment, then either keep the 404 branch or add the 401 case with the same message.

**Effort:** S
**Priority:** P2
**Depends on:** None
