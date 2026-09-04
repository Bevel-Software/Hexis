# KB images: pictures in knowledge pages

Branch: feat/kb-images (worktree `.claude/worktrees/kb-images`, cut from origin/dev at cdf2cb1)
Author: Juan V. with Claude
Date: 2026-09-04
Status: eng review in progress (Sections 1 done in an earlier session; 2 to 4 below)

## Problem

A customer exported ~30 pages from Microsoft Loop. Each page references screenshots in a
sibling `.assets/` folder. The folders can be dropped into the KB today, and the markdown
`![alt](./.assets/x.png)` already survives the sanitizer and reaches the DOM. It renders as
a broken image, because the `<img>` points at an SPA route, not at the file endpoint.

They asked three things: can images go in markdown, where should the files live, and what
is the convention to recommend to their teams.

## What is verified in the code (read on 2026-09-04)

- `GET /api/workspace/:id/file/raw?path=` serves images with the right MIME, `nosniff`,
  a CSP sandbox for SVG documents, and a read-permission gate
  (`packages/core-backend/src/modules/workspace/workspace.routes.ts:555-604`).
- The auth middleware falls back to the `bevel_token` cookie when there is no Bearer
  header, and the comment names image tags as an intended consumer
  (`packages/core-backend/src/modules/auth/auth.middleware.ts:51-63`). The cookie is
  `HttpOnly; SameSite=Lax; Path=/` (`auth.routes.ts:96-102`), and the frontend is served
  same-origin in production (`create-core-server.ts:506`). A plain `<img>` authenticates.
- The workspace id is `encodeURIComponent(branch)` (`event-bus.context.ts:55-60`,
  `shared/workspace-id.ts:30`). Resolving an id lazily clones that branch's workspace
  if it does not exist yet (`workspace.service.ts:1354-1384`).
- Express 5.2.1 sets a weak ETag on `res.send(buffer)` and answers 304 when
  `req.fresh` (`express/lib/response.js:168-199`). The raw route sets no `Cache-Control`.
- `hast-util-sanitize@5.0.2` keeps `img` with `src` limited to http, https and
  relative (`lib/schema.js:43,145,172`). `data:` and `javascript:` are stripped.
- `resolveRelativePath` handles `./`, `../` and root-relative `/KB/x.png`
  (`kb-routes.ts:159-175`). `escapeSpacesInLinkDestinations` matches the `[alt](…)`
  tail of an image too (`shared/markdown/Markdown.tsx:19-26`).
- Folder drag-drop uploads dot-folders unchanged, so Loop's `.assets/` can be dropped
  next to the pages as exported.
- The same pipeline renders in three places: `KbMarkdownView` (Knowledge document view
  via `MarkdownRenderer`, and skill pages via `SkillFilePane`) and `MarkdownDiffViewer`
  (review panel, change-request dialog, file history).
- Eight call sites build the raw URL by hand: ImageRenderer:16, PdfRenderer:80,
  DocxRenderer:46, PptxRenderer:67, XlsxRenderer:116, EmailRenderer:63,
  DownloadFileButton:47 and FileExplorer:459 (the last one was missed in D8's count).

## Decisions locked in the earlier review session (do not re-open)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Review target | The KB images design |
| D3 | /office-hours first | Skip |
| D4 | Scope | Full v1: override + all three surfaces + shared `rawFileUrl` helper + cache headers + tests |
| D5 | No auth cookie | Plain `<img>` plus an explicit placeholder naming the path on error. No blob retry. |
| D6 | Images added inside a change request | Defer. Placeholder names the path; TODO for `?ref=<sha>` on the raw route |
| D7 | External images | `referrerPolicy="no-referrer"` and `loading="lazy"` on every rendered image |
| D8 | Raw URL duplication | One `rawFileUrl(workspaceId, path, { download })` helper replaces every hand-built copy (now nine sites incl. FileExplorer:459 and the new override) |
| D9 | Three backend MIME maps | Flag as TODO with the svg policy note; no change in this PR |
| D10 | Convention docs | README subsection on links and images, plus one sentence in `write_file` and `write_files` descriptions |
| D11 | Absolute `/workspace/<branch>/<path>` image sources | Extract `workspacePathFromKbUrl()` from `openFile`; links and images share it |

Eureka logged: the cookie fallback exists for image tags, so markdown images need only a
`src` rewrite, not the authFetch-to-blob machinery `ImageRenderer` uses.

## Architecture (v1)

```
markdown source                     KB pipeline (kbMarkdownPipeline.tsx)
![alt](./.assets/x.png) ──parse──▶ hast <img src="./.assets/x.png">
                                        │ rehype-sanitize keeps relative / http(s) src
                                        ▼
                               components.img override  ◀── resolveImage(src) injected
                                        │                    by the surface that knows
                                        │                    (workspaceId, current file)
                     ┌──────────────────┼──────────────────────┐
              http(s) src        workspace src              no resolver / unresolvable
                     │                  │                            │
            <img src=as-is        <img src=rawFileUrl(ws, path)     placeholder
             referrerPolicy=       referrerPolicy=no-referrer        "image not found:
             no-referrer            loading=lazy                      <path>"
             loading=lazy>          onError ─────────────────────────▶ (same placeholder)
                                        │
                                        ▼  browser sends bevel_token cookie
                       GET /api/workspace/:id/file/raw?path=…  (read gate, MIME, nosniff,
                                                                 ETag → 304 on revisit)
```

Surfaces and what they inject:

| Surface | Base path for relative src | Workspace id |
|---------|----------------------------|--------------|
| MarkdownRenderer (Knowledge doc) | `filePath` prop | `useWorkspace().workspaceId` |
| SkillFilePane via SkillPage | `${kbDirName}/${skillPath}/${active}` | `useWorkspace().workspaceId` |
| MarkdownDiffViewer via ReviewPanel | `review.fileDiff.path` | checked-out workspace (see D6) |
| MarkdownDiffViewer via ChangeRequestDialog / FileHistoryPanel | payload path | checked-out workspace (see D6) |
| Enterprise `/embed*` routes | none (no providers) | plain `<img>`; relative images stay broken there, as today |

## Implementation steps (v1)

1. `rawFileUrl(workspaceId, path, { download? })` in
   `packages/core-frontend/src/modules/workspace/services/workspace.api.ts`; replace the
   nine hand-built URLs. `PdfRenderer.test.tsx:113` and `FileExplorer.test.tsx:402` already
   assert the URL shape.
2. `workspacePathFromKbUrl(url)` extracted from `openFile` in `kb-routes.ts:200-213`,
   returning `{ branch, path, hash }`; `openFile` calls it. Unit tests in
   `kb-routes.test.tsx`.
3. `img` override in `useKbMarkdownComponents`, driven by a new
   `resolveImage?: (src: string) => string | null` option. A small `KbImage` component
   owns the error state and the placeholder. Attributes per D7 on every image.
4. Wire `resolveImage` from `MarkdownRenderer`, `SkillPage` (through `SkillFilePane` and
   `KbMarkdownView`) and `MarkdownDiffViewer` callers that hold a path.
5. Backend: cache headers on the inline raw response (exact header set decided in
   Section 4 below).
6. Docs: README subsection "Links and images in knowledge pages"; one sentence in the
   `write_file` and `write_files` tool descriptions; `workspace.tools.test.ts:867-873`
   style assertion for the new sentence.
7. TODOs filed per D6 and D9 (and any added below).

## Convention to document (answers the customer's question 3)

Keep images in an `assets/` folder next to the pages that use them (Loop's exported
`.assets/` works unchanged). Access rules follow folders, so co-located images inherit the
read rules of the pages, and moving a folder keeps every relative link valid. One shared
`Uploads/` folder breaks both properties. Reference images with relative links:
`![Approval screen](./assets/approval-screen.png)`.

## What already exists (reused, not rebuilt)

- Raw file route with read gate, MIME table, nosniff, SVG sandbox: reused as-is.
- Cookie auth fallback: reused; it is the whole reason v1 is frontend-mostly.
- `resolveRelativePath`, `escapeSpacesInLinkDestinations`, `openFile`'s absolute-URL
  parse: reused (the parse is extracted, not duplicated).
- Express ETag + 304: reused; no hand-rolled ETag needed.
- Folder drag-drop upload: reused for getting `.assets/` into the repo.
- `nodeIdCache` pattern: not needed once images are plain `<img>` (browser cache does it).

## NOT in scope (considered, deferred)

- `?ref=<sha>` on the raw route so a screenshot that exists only on a change-request
  branch renders in the diff view (D6). TODO.
- Consolidating the three extension-to-MIME maps (D9). TODO.
- Paste or drop an image into the edit textarea, upload to `./assets/`, insert the link
  at the caret. Phase 2.
- Agents in core creating images: `write_file` is text-only and the upload-token tools
  are enterprise-only. Phase 2.
- Blob-URL rescue for token-only sessions with no cookie (D5 rejected).
- Images inside the enterprise `/embed*` routes, which render outside the providers that
  know the workspace.

## Section 2: Code Quality decisions

| # | Finding | Decision |
|---|---------|----------|
| D12 | Three link handlers resolve hrefs by hand (MarkdownRenderer.tsx:160-166, ReviewPanel.tsx:128-134, SkillPage.tsx:674-677, the last one with no decode and no absolute guard, a live drift bug) and images would add three more copies | 12A: one `resolveKbHref(basePath, href)` in kb-routes returning `{kind:'external'} \| {kind:'workspace', branch?, path, hash}`. D11's `workspacePathFromKbUrl` lives inside it. All three link handlers and all three image resolvers call it. Fixes the SkillPage drift. Unit tests: decode, absolute URL with and without kbDirName junk, relative, root-relative, hash split, protocol-relative, empty. **Refined by D23 (outside voice):** signature is `resolveKbHref(href, { basePath, kbDirName })` so the absolute-URL junk repair (`stripJunkBeforeKbDir`, `kb-routes.ts:209`) survives the extraction. Branch rule, documented in a comment and a test: link handlers navigate with the URL's branch as today; image resolvers take the URL's path and ignore its branch, so a cross-branch image URL renders from the checked-out tree or shows the placeholder. |
| D13 | The img override meets six input states and D5 only named one | 13A: explicit branch per state. `http(s)` and protocol-relative `//` pass through with D7 attributes. Empty or sanitizer-stripped src (a pasted `data:` image) renders a labelled placeholder that says inline data images are not supported and to save the file under `./assets/`. No resolver injected renders a plain `<img>` as today. A resolved src that fails to load renders the placeholder naming the workspace path. Failure state is keyed by src so a corrected link recovers without reload. Placeholder is `role="img"` with an aria-label and keeps the alt text. One unit test per branch in `KbMarkdownView.test.tsx`. **Refined by D22 (outside voice):** `resolveImage(src)` returns `{ src, path } \| null` so the placeholder can name the workspace path without parsing a URL. The sanitizer removes a `data:` src before the component runs, so the empty-src placeholder cannot know the cause and reads: "This image has no usable source. Inline data: images are not supported; save the file under ./assets/ and link it." A native `<img>` error carries no HTTP status, so the failure placeholder reads "Couldn't load image: <path>", never "not found". |
| D14 | D6 assumed a CR-branch screenshot "is not on disk"; in fact every branch has a lazily cloned per-user workspace (`workspace.service.ts:1354-1384`), so a raw URL built with the CR branch id would render it at the cost of cloning the whole KB for that reviewer on first open | 14A: all three diff-viewer callers (ReviewPanel, ChangeRequestDialog, FileHistoryPanel) bind `resolveImage` to the checked-out workspace id, with a call-site comment saying why. Images that exist on both branches render; a screenshot that exists only on the CR branch shows the labelled placeholder. The D6 TODO records the lazy-clone route as the alternative to `?ref=`, with its costs: first-open clone, no freshness after later pushes, read gate evaluated against that clone. FileHistoryPanel shows today's file for a past commit, or the placeholder if it was deleted; documented limitation under the same TODO. **Refined by D19 (outside voice):** one resolver for all fragments would show the same bytes on the removed and added sides of a replaced screenshot. Final: `MarkdownDiffViewer` takes `resolveImage` and applies it to unchanged and added fragments only (two memoised component maps); removed fragments render the placeholder "baseline image not shown: <path>". ReviewPanel (working-tree review, where the checked-out tree is the new state) passes the resolver; ChangeRequestDialog and FileHistoryPanel pass none and show placeholders for every relative image until `?ref=`. Tests: one per fragment kind, plus the two no-resolver callers. |

Diff size after Section 2: about 22 source files and 7 test files. Eight of the source files
are one-line URL swaps (D8) and five are one-line prop plumbing. The user accepted the full
scope in D4 knowing it crossed the eight-file smell; the growth since then is D8's ninth site
and D12's three link handlers, both DRY moves rather than new surface.

## Section 3: Test coverage

Framework: vitest in both packages (`packages/core-frontend/vitest.config.ts`, happy-dom;
`packages/core-backend/vitest.config.ts`, real HTTP harness in `workspace.routes.*.test.ts`).
No Playwright or Cypress in the repo, so [→E2E] items are manual checks in the test plan
artifact. No eval harness in the repo, so the tool-description change is covered by a
string assertion in the existing description test.

```
CODE PATHS                                                      USER FLOWS
[~] kb-routes.ts  resolveKbHref (new) + openFile (refactored)   [+] Loop page with ./.assets/ screenshots renders
  ├── [GAP]        external http(s) → kind external               └── [GAP] [→E2E] manual, test plan
  ├── [GAP]        protocol-relative // → kind external          [+] Missing file → placeholder names path →
  ├── [★★ TESTED]  absolute /workspace/<b>/<p>, junk strip           author fixes link → image appears, no reload
  │                 kb-routes.test.tsx:57-81,119 (via openFile)     └── [GAP] component test, src change
  ├── [★★ TESTED]  #hash split — kb-routes.test.tsx:49            [+] Pasted base64 image → "no source" guidance
  ├── [GAP]        percent-decode; malformed % left as-is           └── [GAP] component test
  ├── [★★ TESTED]  relative ./ ../ — MarkdownRenderer.test:171,180 [+] Reviewer opens CR: existing screenshot
  ├── [GAP]        root-relative /KB/x.png                            renders, new one placeholders
  ├── [GAP]        empty href                                       └── [GAP] ReviewPanel/CR dialog tests
  └── [★★★ TESTED] openFile behaviour — kb-routes.test.tsx:45-119  [+] Skill page SKILL.md with ./assets/x.png
                   CRITICAL regression guard, must stay green         └── [GAP] SkillPage.test.tsx
[~] workspace.api.ts  rawFileUrl (new) + 8 swapped sites         [+] Cookie-less session → placeholders
  ├── [★★ TESTED]  inline shape — PdfRenderer.test.tsx:113 (indirect) └── documented (D5), no test
  ├── [★★ TESTED]  download=1 — FileExplorer.test.tsx:382-402      [+] Teammate replaces image → freshness
  ├── [GAP]        unit: spaces, #, ? in path encoded                 └── [GAP] pending Section 4 decision
  └── [GAP]        CRITICAL regression: Image/Docx/Pptx/Xlsx/       [+] Slow network, navigate away mid-load
                   Email/DownloadFileButton assert their fetch URL     └── native <img>, nothing to test
[+] kbMarkdownPipeline.tsx  img override / KbImage (new)
  ├── [GAP]        external src as-is + referrerPolicy + loading
  ├── [GAP]        // src treated external
  ├── [GAP]        empty/stripped src → "no source" placeholder
  ├── [GAP]        no resolver → plain <img>
  ├── [GAP]        resolver → rawFileUrl src
  ├── [GAP]        load error → placeholder naming path
  ├── [GAP]        src change resets failure
  ├── [GAP]        inline HTML <img> (rehype-raw) hits the override
  ├── [GAP]        alt/title kept; placeholder role=img + aria-label
  └── [GAP]        `node` prop not leaked to the DOM (cf. :155-160)
[~] KbMarkdownView  resolveImage prop forwarded          [GAP]
[~] MarkdownRenderer  wiring
  ├── [GAP]        image relative to filePath
  ├── [GAP]        absolute /workspace URL image
  └── [★★ TESTED]  links still navigate — MarkdownRenderer.test.tsx:159-180 (regression guard)
[~] SkillPage / SkillFilePane  wiring
  ├── [GAP]        image relative to ${kbDirName}/${skillPath}/${active}
  ├── [GAP]        CRITICAL regression: link with %20 now opens the right file (drift fix)
  └── [GAP]        kbDirName null → no resolver → plain <img>
[~] MarkdownDiffViewer  prop + ReviewPanel / ChangeRequestDialog / FileHistoryPanel
  ├── [GAP]        prop forwarded to every fragment
  ├── [GAP]        ReviewPanel: base = diffPath, checked-out workspace
  ├── [GAP]        ChangeRequestDialog: images resolve, links stay inert
  ├── [GAP]        FileHistoryPanel: checked-out workspace
  └── [★★ TESTED]  renders with no Router/providers — MarkdownDiffViewer.test.tsx:33 (regression guard)
[~] workspace.routes.ts  raw route cache headers
  ├── [GAP]        Cache-Control on inline response
  ├── [GAP]        Cache-Control on download response
  ├── [GAP]        If-None-Match → 304 (Express built-in, pinned by a test)
  └── [★★★ TESTED] read gate, nosniff, svg — read-gate.test.ts:147, download.test.ts:154,212
[~] workspace.tools.ts  write_file + write_files description sentence
  └── [GAP]        string assertion, pattern of workspace.tools.test.ts:867-873   [→EVAL] n/a
[~] README  links-and-images subsection → manual read, no test

COVERAGE: 9/47 paths tested (19%)  |  Code paths: 9/40 (23%)  |  User flows: 0/7 (0%)
QUALITY: ★★★:2 ★★:7  |  GAPS: 38 (1 E2E manual, 3 CRITICAL regressions, 0 eval)
```

Legend: ★★★ behavior + edge + error | ★★ happy path | ★ smoke | [+] new file/function | [~] modified

CRITICAL regression tests (mandatory, no decision needed):
1. The six renderers whose raw URL is swapped to `rawFileUrl` each assert the exact URL
   their fetch is called with (ImageRenderer, Docx, Pptx, Xlsx, Email, DownloadFileButton;
   Pdf and FileExplorer already do).
2. `openFile` keeps every existing kb-routes.test.tsx case green after `resolveKbHref` is
   extracted under it.
3. SkillPage: a body link to `Some File.md` in a skill doc opens `…/Some File.md`, not
   `Some%20File.md` (the D12 drift fix changes behaviour on an existing path).

D15: close every gap in this PR. Count corrected after the outside voice (D21): the table
below totals 41 cases, plus D17's three hook cases, so 44 new cases and the 3 CRITICAL
regressions are among them. D21 kept D8 (all nine URL swaps) and D15 (all cases) against
Codex's scope objection; the swaps are one-line and each is guarded by a URL assertion.
Test files by gap:

| Gap group | File | Cases |
|-----------|------|-------|
| resolveKbHref grammar | `routing/__tests__/kb-routes.test.tsx` | external, `//`, absolute with and without junk, hash, decode incl. malformed `%`, relative, root-relative, empty (8) |
| KbImage states | `renderers/__tests__/KbMarkdownView.test.tsx` | external attrs, `//`, empty/stripped, no resolver, resolved src, load error, src change recovers, inline HTML img, alt/title + role/aria, no `node` leak (10) |
| KbMarkdownView prop | same file | resolveImage forwarded (1) |
| MarkdownRenderer wiring | `renderers/__tests__/MarkdownRenderer.test.tsx` | relative image, absolute-URL image (2) + existing link cases stay green |
| SkillPage wiring | `library/__tests__/SkillPage.test.tsx` | relative image under skill folder, `%20` link drift fix (CRITICAL), kbDirName null (3) |
| Diff viewer | `review/components/__tests__/MarkdownDiffViewer.test.tsx`, `ReviewPanel.test.tsx`, CR dialog and file-history tests | prop reaches fragments, ReviewPanel base + workspace, CR dialog images resolve while links stay inert, FileHistoryPanel binding (4) + no-providers case stays green |
| rawFileUrl | `services/__tests__/workspace.api.test.ts` | encoding of spaces, `#`, `?`; download flag (2) |
| Swapped URL sites (CRITICAL) | Image/Docx/Pptx/Xlsx/Email/DownloadFileButton tests | each asserts its fetch URL (6) |
| Raw route | `workspace/__tests__/workspace.routes.download.test.ts` | Cache-Control inline, Cache-Control download, If-None-Match → 304 (3) |
| Tool descriptions | `workspace/__tests__/workspace.tools.test.ts` | sentence on write_file and write_files (1) |

Manual (no e2e harness): the Loop-export flow and the CR reviewer flow, in the test plan
artifact `empire23-feat-kb-images-eng-review-test-plan-20260904-2040.md`.

## Section 4: Performance decisions

| # | Finding | Decision |
|---|---------|----------|
| D16 | `workspace.routes.ts:577` buffers the whole file and `res.send` makes Express hash it for a weak ETag on every request, so each revalidation is a full read plus sha1 per image; the route sets no `Cache-Control`, so a shared cache may store one user's authenticated file | 16A: `workspaceService.resolveFilePath(workspaceId, relativePath)` lifts the traversal check out of `readFileBinary`; the route keeps its gates, Content-Type map, nosniff, SVG CSP and Content-Disposition, sets `Cache-Control: private, no-cache` itself, then `res.sendFile(abs, { dotfiles: 'allow', cacheControl: false, etag: true, lastModified: true, acceptRanges: true })`. `dotfiles: 'allow'` is mandatory or every file under Loop's `.assets/` 404s. Tests: If-None-Match → 304 with no body, a dotfile path serves, Cache-Control on inline and download, `..` traversal still rejected, existing gate and header tests unchanged. Replaces D4's "ETag on raw route" item, which Express already provided. **Superseded by D18 (outside voice):** `res.sendFile` routes failures through a callback, bypassing the catch block that maps errors to 404/400 (`workspace.routes.ts:604-620`), and both route harnesses stub `readFileBinary` (`download.test.ts:87`, `read-gate.test.ts:71`). Uploads are capped at 50 MB. Final: keep `readFileBinary` + `res.send`; add `Cache-Control: private, no-cache` on inline and download; one test pins If-None-Match → 304. Streaming via `sendFile` (with `dotfiles: 'allow'` and a callback that maps ENOENT → 404) is a TODO with a measurement trigger. |
| D17 | `file-changed` re-reads the document (`useWorkspaceState.ts:1242-1260`) but a replaced image under the same name keeps its old bytes in an open tab until reload | 17A: `useImageVersions(workspaceId)` hook in the workspace module subscribes to `file-changed`, keeps a Map path → counter for image extensions, and the Knowledge view's and skill page's `resolveImage` append `&v=<n>`. Diff viewers do not use it. Tests: bump on a matching event, no bump for another workspace's event, non-image paths ignored. **Challenged by the outside voice (D20), kept:** `fsRevision` (`workspace.context.ts:100-106`) is bumped only by the local user's own mutations (`useWorkspaceState.ts:114,1046-1064`), never by the SSE `file-changed` handler (`:1242-1260`), and `CoreAppShell.tsx:136` re-polls git status on every bump, so it does not carry the teammate signal this feature needs. |

## Outside voice (Codex, gpt reasoning high, read-only, 2026-09-04)

Ten findings. Disposition after verification and user decisions:

| Codex # | Claim | Verified? | Outcome |
|---------|-------|-----------|---------|
| 1, 9 | `sendFile` bypasses the route's catch; both harnesses stub `readFileBinary`; 50 MB cap makes streaming premature | Yes (`workspace.routes.ts:604-620`, `download.test.ts:87`, `read-gate.test.ts:71`, `MAX_UPLOAD_BYTES`) | D18: accepted. Header only; streaming is a TODO |
| 2 | One resolver for all diff fragments shows the same bytes on removed and added sides | Yes (`MarkdownDiffViewer.tsx:297-330`) | D19: per-fragment rule; CR dialog and history get no resolver |
| 3, 4, 7 | Resolver must return the path; sanitizer erases the `data:` evidence; `<img>` error has no status | Yes (`schema.js:145`) | D22: structured return, honest wording |
| 5 | `resolveKbHref` lacks `kbDirName`; image branch rule unstated | Yes (`kb-routes.ts:209`) | D23: options object, rule documented and tested |
| 6 | Reuse `fsRevision` instead of a new hook | Partly wrong: bumped by own mutations only, not SSE (`useWorkspaceState.ts:114,1046-1064,1242-1260`); coupled to git-status polling (`CoreAppShell.tsx:136`) | D20: 17A kept |
| 8 | Cookie-auth premise has no automated test | Yes (route tests inject `userId`, `read-gate.test.ts:84`) | D24: middleware unit cases plus one real-middleware route case |
| 9 (scope) | Nine URL swaps and 40+ tests widen the regression surface | Judgment call | D21: D8 and D15 kept under stated DRY and test preferences |
| 10 | Test count was 38, table totals 40+ | Yes | Corrected to 44 |

Cross-model tension resolved in the user's favour on 6, 9 (scope); in Codex's favour on 1/9
(streaming), 2, 3/4/7, 5, 8. No unresolved tension.

Section 3 addition from D24: `packages/core-backend/src/modules/auth/__tests__/auth.middleware.test.ts`
(new): cookie only → next() with userId; Bearer wins when both present; neither → 401;
malformed or empty cookie → 401. Plus one case in `workspace.routes.download.test.ts` that
mounts the real `createAuthMiddleware` and sends only a `Cookie: bevel_token=…` header,
expecting 200. Total new cases: 49.

## Implementation steps (v1, revised after Sections 2 to 4)

1. `rawFileUrl(workspaceId, path, { download? })` in `services/workspace.api.ts`; swap the
   nine hand-built URLs (D8). Each swapped renderer test asserts its fetch URL (D15).
2. `resolveKbHref(basePath, href)` in `routing/kb-routes.ts` with `workspacePathFromKbUrl`
   inside it (D11, D12). `openFile` and the three link handlers call it. SkillPage's
   handler gains decode and the absolute guard (drift fix). Unit suite of 8 cases.
3. `KbImage` component and the `img` override in `kbMarkdownPipeline.tsx`, driven by
   `resolveImage?: (src: string) => string | null` (D5, D7, D13). Ten cases.
4. `resolveImage` prop through `KbMarkdownView` and `SkillFilePane`; wired from
   `MarkdownRenderer` and `SkillPage`; `MarkdownDiffViewer` prop wired from `ReviewPanel`,
   `ChangeRequestDialog` and `FileHistoryPanel`, bound to the checked-out workspace with a
   comment (D14).
5. `useImageVersions(workspaceId)` hook; Knowledge view and skill page append `&v=` (D17).
6. Backend: `resolveFilePath` on the service; raw route switches to `res.sendFile` with
   `dotfiles: 'allow'`, `cacheControl: false`, and sets `Cache-Control: private, no-cache`
   (D16). Four route tests.
7. Docs: README subsection; one sentence in `write_file` and `write_files`; description
   assertion (D10).
8. TODOs filed (see below).

Inline ASCII diagram comments to add in code: the state table of `KbImage` (six input
states → output) at the top of the component; the href grammar above `resolveKbHref`
(external / protocol-relative / absolute app URL / relative / root-relative / hash); the
request flow above the raw route (gates → headers → sendFile → 304 path). The existing
diagram-free comments in `kbMarkdownPipeline.tsx:1-35` stay accurate; the sentence "NAVIGATION
IS INJECTED, NEVER LOOKED UP" should gain "and so is image resolution".

## Failure modes

| New codepath | Realistic production failure | Test | Handling | What the user sees |
|--------------|------------------------------|------|----------|--------------------|
| KbImage load | Cookie stripped by a proxy, expired, or file missing/forbidden: `<img>` fires `error` with no status | Yes (load error case) | Placeholder | "Couldn't load image: <path>", alt text kept. Clear. |
| KbImage src | Sanitizer removed a `data:` src, or `![alt]()` | Yes (empty src case) | Placeholder | "This image has no usable source…" with the `./assets/` hint. Clear. |
| resolveKbHref | Malformed percent-escape makes `decodeURIComponent` throw | Yes | Left as-is, same as today's handlers | Link or image resolves against the raw string; image likely placeholders. Clear. |
| resolveImage | `workspaceId` still null when content renders | Yes (resolver returns null case) | Resolver returns null → failure placeholder naming the raw src | Not reachable in practice: content itself is fetched by workspaceId. Clear if it happens. |
| Diff per-fragment | Replaced screenshot under the same name | Yes (one per fragment kind) | Removed fragments never resolve | "baseline image not shown: <path>" on the red side; current bytes on the green side of a working-tree review. Clear. |
| useImageVersions | SSE disconnected when a teammate replaces an image | No (documented) | SSE layer reconnects; `no-cache` fixes it on next mount | Old image until reload or next visit. Silent but bounded; text has the same property today. Not critical. |
| Cache-Control | A CDN configured to ignore `private` | Yes (header present) | None beyond the header | No worse than today, where no header exists. |
| Auth middleware | Malformed cookie value | Yes (D24 case) | 401 | Placeholders, and SSE stops, which the app already treats as a broken session. |

No critical gaps: every failure has handling and either a visible message or a documented,
bounded staleness.

## Worktree parallelization

| Step | Modules touched | Depends on |
|------|-----------------|------------|
| A. resolveKbHref + link handlers (T2) | workspace/routing/, renderers/MarkdownRenderer, review/ReviewPanel (link handler only), library/skill-page | — |
| B. rawFileUrl + nine swaps (T1) | workspace/services/, renderers/ (Image, Pdf, Docx, Pptx, Xlsx, Email, DownloadFileButton), workspace/components/FileExplorer | — |
| C. KbImage + img override + KbMarkdownView prop (T3) | renderers/kbMarkdownPipeline, renderers/KbMarkdownView | — |
| D. Backend: Cache-Control + 304 pin, auth middleware tests, tool descriptions (T7, T8, T9-backend) | core-backend/workspace, core-backend/auth | — |
| E. README subsection (T9-docs) | README.md | — |
| F. Wiring + diff per-fragment + version hook (T4, T5, T6) | renderers/MarkdownRenderer, library/skill-page, review/MarkdownDiffViewer + callers, workspace/hooks | A, B, C |

Lanes: A, B, C, D, E in parallel worktrees; F after all three frontend lanes merge.
Conflict flags: A and F both touch renderers/MarkdownRenderer and review/ReviewPanel, which is
why F is sequential. B and C are disjoint. D and E touch nothing the frontend lanes do.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above.
Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~2h / CC: ~10min)** — workspace.api + renderers — Add `rawFileUrl(workspaceId, path, { download })` and swap the nine hand-built raw URLs
  - Surfaced by: Architecture D8, Code Quality (FileExplorer:459 ninth site), D21 kept
  - Files: services/workspace.api.ts, renderers/{Image,Pdf,Docx,Pptx,Xlsx,Email}Renderer.tsx, renderers/DownloadFileButton.tsx, components/FileExplorer.tsx, their tests
  - Verify: each renderer test asserts its fetch URL; `pnpm -F core-frontend test`
- [ ] **T2 (P1, human: ~3h / CC: ~15min)** — kb-routes — Extract `resolveKbHref(href, { basePath, kbDirName })` with `workspacePathFromKbUrl`; route `openFile` and the three link handlers through it; fix the SkillPage decode drift
  - Surfaced by: Architecture D11, Code Quality D12, outside voice D23
  - Files: routing/kb-routes.ts, renderers/MarkdownRenderer.tsx, review/ReviewPanel.tsx, library/skill-page/SkillPage.tsx, kb-routes.test.tsx, SkillPage.test.tsx
  - Verify: 8 new resolver cases; existing openFile suite green; `%20` link case in SkillPage.test.tsx
- [ ] **T3 (P1, human: ~4h / CC: ~15min)** — kbMarkdownPipeline — `KbImage` and the `img` override with `resolveImage` returning `{ src, path } | null`, D7 attributes, six explicit states, honest wording
  - Surfaced by: Architecture D5/D7, Code Quality D13, outside voice D22
  - Files: renderers/kbMarkdownPipeline.tsx (or renderers/KbImage.tsx), renderers/KbMarkdownView.tsx, KbMarkdownView.test.tsx
  - Verify: 10 KbImage cases plus the prop-forwarding case
- [ ] **T4 (P1, human: ~2h / CC: ~10min)** — surfaces — Wire `resolveImage` from MarkdownRenderer and SkillPage (through SkillFilePane and KbMarkdownView)
  - Surfaced by: Scope D4
  - Files: renderers/MarkdownRenderer.tsx, library/skill-page/SkillFilePane.tsx, SkillPage.tsx, their tests
  - Verify: relative and absolute image cases in MarkdownRenderer.test.tsx; skill-folder image and kbDirName-null cases in SkillPage.test.tsx
- [ ] **T5 (P1, human: ~2h / CC: ~10min)** — MarkdownDiffViewer — Per-fragment image rule; ReviewPanel passes the resolver bound to the checked-out workspace; ChangeRequestDialog and FileHistoryPanel pass none
  - Surfaced by: Code Quality D14, outside voice D19
  - Files: review/MarkdownDiffViewer.tsx, review/ReviewPanel.tsx, change-requests/ChangeRequestDialog.tsx, git/FileHistoryPanel.tsx, their tests
  - Verify: one case per fragment kind; no-providers case stays green; two no-resolver caller cases
- [ ] **T6 (P2, human: ~2h / CC: ~10min)** — workspace/hooks — `useImageVersions(workspaceId)` fed by `file-changed`; Knowledge view and skill page append `&v=`
  - Surfaced by: Performance D17, kept in D20
  - Files: workspace/hooks/useImageVersions.ts (new), MarkdownRenderer.tsx, SkillPage.tsx, hook test
  - Verify: bump on matching event; no bump for another workspace; non-image paths ignored
- [ ] **T7 (P1, human: ~30min / CC: ~3min)** — workspace.routes — `Cache-Control: private, no-cache` on inline and download raw responses; pin If-None-Match → 304
  - Surfaced by: Performance D16, outside voice D18
  - Files: core-backend/modules/workspace/workspace.routes.ts, workspace.routes.download.test.ts
  - Verify: two header assertions and one 304 case; `pnpm -F core-backend test`
- [ ] **T8 (P1, human: ~1.5h / CC: ~8min)** — auth — `auth.middleware.test.ts` (cookie only, Bearer wins, neither, malformed) plus one raw-route case with the real middleware and a Cookie header
  - Surfaced by: outside voice D24
  - Files: core-backend/modules/auth/__tests__/auth.middleware.test.ts (new), workspace.routes.download.test.ts
  - Verify: five cases green
- [ ] **T9 (P2, human: ~1h / CC: ~5min)** — docs — README "Links and images in knowledge pages" subsection; one sentence in `write_file` and `write_files` descriptions with an assertion
  - Surfaced by: Architecture D10
  - Files: README.md, core-backend/modules/workspace/workspace.tools.ts, workspace.tools.test.ts
  - Verify: description assertion green; README renders
- [ ] **T10 (P2, human: ~1h / CC: ~5min)** — comments — ASCII state table above KbImage, href grammar above resolveKbHref, request flow above the raw route; pipeline header gains "and so is image resolution"
  - Surfaced by: Documentation and diagrams preference
  - Files: kbMarkdownPipeline.tsx, kb-routes.ts, workspace.routes.ts
  - Verify: review read

## Completion summary

- Step 0: Scope Challenge — scope accepted as-is (full v1, D4; complexity smell acknowledged by the user)
- Architecture Review: 7 issues found (D5–D11, earlier session)
- Code Quality Review: 3 issues found (D12–D14)
- Test Review: diagram produced, 44 gaps identified, 49 cases planned after D24
- Performance Review: 2 issues found (D16, D17)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 5 items proposed to user, 5 accepted, TODOS.md created in the worktree
- Failure modes: 0 critical gaps flagged
- Outside voice: ran (codex), 10 findings, 7 tension points put to the user, 5 accepted, 2 kept
- Parallelization: 6 lanes, 5 parallel / 1 sequential
- Lake Score: 16/21 recommendations chose the complete option (D5, D6, D9, D14, D18 chose the smaller, each with a recorded reason)
- Unresolved decisions: 0

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 56 issues (7 architecture, 3 code quality, 2 performance, 44 test gaps), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** Codex ran as the plan's outside voice (codex-plan-review, 2026-09-04, commit cdf2cb1): 10 findings, 7 tension points put to the user. Codex prevailed on streaming (D18), diff-fragment truthfulness (D19), resolver contract and placeholder wording (D22), the missing kbDirName input (D23) and the untested cookie premise (D24). The review prevailed on the version hook (D20, Codex's premise about fsRevision was wrong) and on scope (D21, user's stated DRY and test preferences). Both agreed the test count needed correcting.
- **VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
