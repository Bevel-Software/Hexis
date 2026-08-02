# MASTER PLAN — KNOWLEDGE UI

Owner: **Juan**. Repo: `/Users/empire23/CodeBases/skill-and-tool-management`.
Branch: **`knowledge-ui`**, cut from `skills-and-tools-ui` (which carries the design system,
the primitives barrel, the token file and the ratchet).
Executors: autonomous coding agents. **Read this file in full before opening any source file.**

Source of truth for the design: `skill-prototype-juan.html` (the approved prototype),
Knowledge surface — `#app=kb`. Every line reference below of the form `(proto:NNN)` is a
verified line in that file at the commit this plan was written against (`ec62b6b`).
Every `path.tsx:NN` reference was likewise verified to exist.

> **Revision 2 — after a full fact-check.** Every claim in revision 1 was audited against
> both the prototype and the platform source, in both directions (is each claim true; and
> what did the plan miss). 33 defects were confirmed. Three were structural and are the
> reason this revision exists:
>
> 1. **WP6 named the wrong data source and ignored a path-space mismatch** — the dots would
>    have matched zero files, silently. See D3 / D3a.
> 2. **WP1 would have broken the file lock** — `FileViewer.tsx:847` is the scroll-activity
>    source for the idle-release timer, and "the scroll container moves" is a change to four
>    renderers, not to one div. See WP1 steps 3-4.
> 3. **WP4's header contract could not build the header** — four props were missing, one of
>    which gates the Edit button and has a test asserting it. See §4.2.
>
> The rest were reference errors, now corrected in place. Two are worth knowing about
> because they change how you read the gate and the risk list: the ds:check **baseline is
> stale** (§2.2 — there is 167 counts of unearned slack), and the a11y attributes §2.3 calls
> "frozen" **do not exist yet** — this branch creates them.

---

## 0. What this is, and the one sentence that governs it

Skills & Tools was rebuilt onto the prototype across 27 commits. Knowledge was not touched.
The result is one application wearing two faces: a Library that is a warm, tokenised,
document-shaped surface, and a Knowledge base that is still an IDE — emerald folder icons,
material-theme file glyphs, a compact `h-10` chrome strip, a viewer that runs edge to edge.

**The governing sentence: Knowledge and Skills are two views of one product, and a page must
not visibly change species when you switch between them.** Everything below follows from
that, and anything below that stops serving it should be cut rather than defended.

This is a **UI** plan. It adds no backend endpoint, no database table, no migration, and no
new route. Every datum it renders is already on the wire (§4.3 proves this field by field).
That is deliberate: the Library work needed a backend because groups did not exist as a
concept; Knowledge already exists, it is just dressed wrong.

---

## 1. The delta — prototype vs. platform, surface by surface

Read this table as the specification of intent; §5 is the specification of work.

| # | Surface | Prototype | Platform today | Verdict |
|---|---|---|---|---|
| 1 | **Document measure** | `.wrap{max-width:880px;padding:34px 40px 110px}`, `.wrap.wide{max-width:980px}` with the rail (proto:137-138) — **but Knowledge overrides the top**: `.wrap.kb{padding-top:12px}` (proto:699). See the note below the table. | Viewer pane is `flex-1 … p-4`; each renderer owns its own scroller and runs the full pane width (`FileViewer.tsx:847`) | **Adopt.** A 2000px line of prose is not a reading surface. |
| 2 | **Collapsed gutters** | `.app.collapsed .wrap{padding-left:64px;padding-right:64px}` (proto:709) — hiding the nav buys margin, not line length | Collapsing the explorer pane hands every reclaimed pixel to the text | **Adopt.** |
| 3 | **Tree rows** | Name + one caret. No folder icon, no file icon. 13px/`--ink2`, radius 7, `6px 10px`, indent `10 + depth*13` (proto:683-693, 3560-3580) | Chevron + `Folder`/`FolderOpen` lucide icon + `@iconify` material-theme per-extension file glyph; roots tinted emerald; indent `12 + depth*16`, files `+18` (`FileExplorer.tsx:472, 598-607, 783-789`) | **Adopt the prototype.** The caret is the only actionable thing in the row; the extension already says what a `.csv` is. |
| 4 | **Tree ↔ Library sidebar parity** | One typographic system across both sidebars — explicitly (proto:680-682) | The Library side is **already there**: `GroupsSidebar`'s `rowClass` (`:68-72`) is a token-for-token match of the prototype's `.trow` — `rounded-sm`=7px, `px-2.5`=10px, `py-1.5`=6px, `text-ui`=13px. Knowledge is the half that never got ported; `.trow` exists only in the prototype (zero hits in `core-frontend`). | **Port, don't reconcile.** There is no disagreement to settle — WP2 copies `rowClass` onto the tree. |
| 5 | **Sections** | `KnowledgeBase/`, `Data/` are ordinary depth-0 rows | Synthetic sections (Knowledge, Data, Agents, Pipelines, Groups, legacy Skills/Tools) + `Pinned` + a loose-files divider (`FileExplorer.tsx:907-962, 1018-1065`) | **Keep the platform's structure, drop its decoration.** Depth-0 is the signal; the emerald tint is not. |
| 6 | **Tab strip** | `.kbtabs` — underline on active (`inset 0 -2px 0`), close `×` on hover/active only, accent dot when the file has an open change request (proto:712-723, 3816-3825) | `EditorTabs` pills on `bg-sunken`, no underline, no CR signal. **The close control already behaves correctly** — `opacity-0 group-hover:opacity-100 focus:opacity-100` (`EditorTabs.tsx:274`). | **Adopt the chrome only.** The reveal behavior is done; WP3 changes `focus:` → `focus-visible:` and nothing else about it. |
| 7 | **Page title** | `<h1>` = basename minus extension, with the page's actions beside it (proto:3784-3803) | A 40px chrome strip: 14px filename + 11.5px parent dir + state chips + tab trio + copy-link + Edit (`FileViewer.tsx:618-717`) | **Adopt.** The document names itself; chrome does not. |
| 8 | **Page actions** | Share (bounded, with a chevron menu), Copy page as Markdown, Edit (icons), then `⋯`: File details / Version history / View raw / Copy path (proto:3785-3803) | Copy-link icon + Edit button in the chrome strip; History and Compare as sibling tabs; no Share; no raw view; no copy-as-markdown | **Adopt**, with History/Compare folded behind `⋯` (§3 D4). |
| 9 | **Weight follows stakes** | Share is the one bounded button — it is the one action with a consequence for other people; copy and edit are icons (proto:3781-3783) | Edit is a filled emerald button; Share does not exist on the page at all | **Adopt.** |
| 10 | **The rail** | `<aside>` "About this file": Path (mono), Size, Edited by, Access pill; then "Links out" (proto:3859-3875). Toggled from `⋯`; drives `.wrap.wide` | Does not exist. Owners appear as a full-width banner (`NodeOwnersBanner`); path appears as grey text in the chrome strip | **Adopt**, sourced per §4.3. |
| 11 | **Change-request dock** | Pinned under the tree: collapsible header + amber count + rows `#32 · title · "Ali Raza · 1 file"` (proto:730-750, 3673-3685) | `PullRequestsForMe` at the bottom of the explorer — same job, different voice (`FileExplorer.tsx:1069`) | **Restyle in place.** Do not rebuild. |
| 12 | **Per-file CR signal** | 6px amber `.tdot` on the tree row; accent `.tdirty` on the tab (proto:692, 3577, 3821) | Nothing | **Adopt** — but from a **different fetch than the dock**, and after a path-space conversion. Both traps are spelled out in D3 and WP6; read them before building either. |
| 13 | **Open-CR panel** | Amber panel above the body: "Open change request … Review the change" (proto:3805-3809) | Nothing on the page | **Adopt.** |
| 14 | **Right-click menu** | Manage access… / Download / Copy path / New file here (proto:3290-3311) | Nearly a superset: New file, New folder, Unzip, Download, Manage access, Pin, Rename, Delete (`FileExplorer.tsx:171-255`) — **but no Copy path**; there is no clipboard handler anywhere in the tree. | **Keep the platform's, and add Copy path.** It is the one prototype item the platform lacks, and WP4's page-level `⋯ → Copy path` does not cover it (that only reaches the open file, never a folder row or an unopened one). |
| 15 | **Share sheet** | `kbAccessModal` — add by email/group, "On this file", collapsible inherited-grant rows per folder (proto:3598+) | `ManageAccessDialog` — 1235 lines, direct-vs-ancestor sources, verb editor, already on the shared `Dialog`/`Menu` (`f905957`) | **Keep the platform's.** Build only the entry points. |
| 15b | **Breadcrumbs** | Deliberately absent in Knowledge — "the tree already shows where this file sits" (proto:3773-3775) | Absent | **Already agrees.** Do not add one. |
| 16 | **Empty state** | — | "Open a file, or ask the process assistant a question." + suggested prompts (`FileViewer.tsx:566-602`) | **Keep**, retypeset onto tokens. |
| 17 | **Banners** | — | Five inline strips in `FileViewer`; **four** carry a raw palette (`:734`, `:777` amber; `:791`, `:827` red). The fifth (`:752`, Accept/Reject) is already on `bg-sunken`/`border-line-strong`. 17 raw-palette occurrences under `modules/workspace/` in total. | **Retypeset all five** onto `Banner` — the tokenised one for consistency of shape, the four others for the ratchet too. |
| 18 | **Sidebar toggle glyph** | One `I_PANEL` glyph, one spot in the top bar, both surfaces (proto:3696) | Library uses `SidebarToggle`'s `PanelGlyph`; Knowledge uses lucide `PanelLeft` (`Toolbar.tsx:72`) | **Unify** on `PanelGlyph`. |

**The one measure the two surfaces deliberately do NOT share: top padding.** The app-wide
`.wrap` gives 34px, and Knowledge overrides it to 12px (`.wrap.kb`, proto:699). The reason
is at proto:695-698, in the prototype's own words: *"The Knowledge column starts high: the
top bar already separates it from the window, so the page's own padding only has to keep the
tabs from touching the bar. The Skills pages keep the roomier default — they open on a
heading, not on a tab strip."* Sides (40px) and bottom (110px) are shared. Do not "fix" the
12px back to 34px later; it is the considered value, and §9 has an acceptance line for it.

**Not in scope, and why** — the prototype's top-bar branch picker (the enterprise registry
already contributes one, and it is not ours to replace), the app switcher (already built),
the `.kbtable` CSV renderer and `.kbimg` image renderer (the platform's real renderers are
strictly better than the prototype's mock), `mdRender` (`MarkdownRenderer` + `KbMarkdownView`
are real and tested), and anything under `modules/pr/` or `modules/review/` (§2.1).

---

## 2. Global constraints

### 2.1 Division of labor — what you must never touch

Carried forward verbatim from `00-MASTER-PLAN.md` §1 and still binding:

- **Ali owns** `packages/core-frontend/src/modules/pr/`, `packages/core-frontend/src/modules/review/`,
  the skill half of `DetailDialog.tsx`, and the skill page.
- **`git diff` at the end of every work package below must show ZERO changes** under
  `modules/pr/` and `modules/review/`.

Three seams need care because Knowledge work runs adjacent to them:

1. **`FileViewer.tsx` is shared territory.** It mounts `useReview()`, computes
   `hasPendingReview`, renders `review.lastError`, and renders `registeredPanels` from
   `registry.fileViewerPanels` (`:110-117, 826-839, 878`). The enterprise agent-review badge
   is one of those panels. **Every one of these must survive re-layout byte-identical in
   behavior.** Move them; do not rewrite them.
2. **`PullRequestsForMe` lives in `modules/git/components/`, not `modules/pr/`** — so it is
   in bounds by the letter of the rule. It is PR-adjacent by subject. WP6 restyles it and
   changes no fetching, polling, pruning or error logic. If Ali objects to the boundary,
   the fallback is a wrapper component in `modules/workspace/` that renders his component
   inside our chrome — same pixels, zero shared file.
3. **`registry.panes` is an integration contract with the enterprise package.** The chat
   pane registers at `order: 30` (`CoreAppShell.tsx:159-161`). Nothing in this plan may
   change the pane protocol, the `LayoutController`, or `AppLayout`'s props.

### 2.2 Design system rules (apply to every file created or modified)

- Primitives **only** from `packages/core-frontend/src/shared/components` —
  `Button`, `IconButton`, `Surface`, `ListRow`, `Badge`, `Banner`, `TextField`,
  `TextAreaField`, `MenuPanel`/`MenuItem`/`MenuLabel`, `Dialog`, `PageShell`.
  Never deep-import a primitive's file.
- Semantic tokens only: `text-ink/-muted/-faint`, `bg-canvas/sidebar/surface/surface-hover/sunken/hover/scrim`,
  `border-line/-strong`, the ten named type steps
  (`micro/label/meta/detail/ui/body/strong/lede/title/head/display-sm/display`),
  `rounded-xs/sm/md/lg/xl/2xl`, status `ok/wait/danger` (+ `-soft`, + `wait-dot`).
- **NO raw hex in a class, NO `text-[Npx]`, NO bare `rounded`, NO `slate-*`.**
  The slate palette is deleted from the build and fails **silently** — a stray
  `text-slate-600` renders at the inherited colour and nothing errors.
- Class composition via `cn()` from `lib/utils` only.
- Gate: `pnpm ds:check`. **The recorded baseline is not the current balance** — the Library
  migration already banked a large surplus that was never re-baselined:

  | Counter | Baseline file | Actual at `ec62b6b` | Slack |
  |---|---|---|---|
  | `raw-slate-palette` | 0 | 0 | hard ban |
  | `raw-hex-in-class` | 106 | **65** | 41 |
  | `off-scale-font-size` | 212 | **138** | 74 |
  | `bare-rounded` | 203 | **151** | 52 |

  So `ds:check` currently passes with 167 counts of headroom, and a WP could add 40 raw
  hexes and still be "green". **Do not lean on that.** The rule for this branch is stricter
  than the gate: measure the actual counts before and after each WP (`node
  scripts/design-system-ratchet.mjs`) and require the ACTUAL number to fall or hold.
  Knowledge holds 17 raw-palette occurrences of its own; retiring them is WP7's job.
  Re-baseline once at the end of WP7, downward, with `pnpm ds:baseline`.

### 2.3 Testing rules

- vitest + happy-dom + `@testing-library/react`. Router via `MemoryRouter`.
- Select **only** by role / accessible name / `aria-label` / `title` / text.
- **The a11y contract is something this branch CREATES, not something it preserves.**
  `modules/workspace/` today contains exactly one ARIA/role attribute of interest —
  `role="tablist"` at `EditorTabs.tsx:43` — plus a `role="alert"` at `FileExplorer.tsx:999`.
  `aria-current` and `aria-expanded` appear **zero times** in the whole module. So the
  prototype's handles have to be added as the WPs go:
  | Handle | Where | Added by |
  |---|---|---|
  | `aria-current` on the open file's row | tree | WP2 |
  | `aria-expanded` on directory rows | tree | WP2 |
  | `aria-current` on the active tab | tab strip | WP3 |
  | `aria-expanded` on the CR dock header | dock | WP6 |
  | `aria-label` on every icon-only control | title block, tree, dock | WP2/4/6 |
  Once added they ARE frozen — later WPs select on them.
- **The three new menus need behavior `MenuPanel` does not provide.** Its own docstring
  (`shared/components/Menu.tsx:17-19`) says it "is presentation only — it does not portal,
  trap focus, or own open state." The prototype dismisses all of its menus on outside click
  and on Escape (proto:4255-4273). WP2 (context menu), WP4 (Share chevron, `⋯`) each own
  that wiring themselves: outside-click close, Escape close, focus returned to the trigger.
- Never assign `window.location.href` in a test.
- Baseline to preserve: **66 frontend test files**. The 14 that cover this surface are NOT
  all in one directory — they sit in six:
  `components/__tests__/` (FileExplorer, EditorTabs, FileRoute, FileViewer),
  `components/renderers/__tests__/` (CsvRenderer, PdfRenderer, htmlSandbox, KbMarkdownView,
  MarkdownRenderer), `hooks/__tests__/` (useWorkspaceState.test.tsx),
  `__tests__/` (useWorkspaceState.test.ts), `routing/__tests__/` (kb-routes),
  `services/__tests__/` (workspace.api), `utils/__tests__/` (frontmatter).
  New tests go beside the code they cover, matching that layout.
  **Your WP may only ADD tests, never delete a case.** Where a WP changes a component's
  chrome, the existing test's *selector* may move but its *assertion* must survive: if a
  test asserted "clicking the tab opens the file", it must still assert that afterwards.

### 2.4 Verification loop — run for every work package, before declaring it done

```
pnpm -s typecheck        # tsc --noEmit across the workspace
pnpm -s test             # vitest run; may only ADD to the baseline
pnpm -s build
pnpm ds:check            # must not increase any counter
```

Plus a visual check against the prototype at the same viewport. The prototype is a static
file: open `skill-prototype-juan.html#app=kb` beside the running app and compare. A WP whose
diff cannot be justified against a specific prototype line is out of scope.

### 2.5 Environment facts you must not rediscover wrong

- Knowledge's route prefix **is** `KB_ROUTE_PREFIX = '/workspace'` (`kb-routes.ts:7`).
  URLs are `/workspace/<branch>/<path>` or `/workspace/<branch>/<node-id>`; `FileRoute`
  tells the two apart with `NODE_ID_LINK_RE` and canonicalizes path→id
  (`FileRoute.tsx:33-34, 99-118`). **This plan adds no route and changes no URL.**
- The URL is the single authority for what is active. `FileRoute` has one direction of
  sync only, and the comment at `FileRoute.tsx:276-286` records the oscillation bug that a
  reactive state→URL effect caused. **Do not add one.**
- Tabs are path-keyed and persisted per `(workspaceId, branch)` (`tab-persistence.ts`,
  `FileRoute.tsx:167-201`).
- Edit mode is explicit and lock-gated: `handleEnterEditMode` acquires the lock and
  reloads from disk *before* flipping the mode, non-optimistically, and the comment at
  `FileViewer.tsx:345-352` records why. **Moving the Edit button must not move that logic.**
- `ManageAccessDialog` takes an optional `workspaceId` and defaults to the ambient
  workspace context — which is exactly what a Knowledge-surface caller wants.
- Access is a property of a **path**, and it inherits. The dialog already models
  direct-vs-ancestor sources; the prototype's collapsible inherited rows are the same fact
  in different clothes.

---

## 3. The load-bearing decisions

These are the calls that, if made differently later, invalidate the work packages. They are
numbered so a WP can cite them.

**D1 — The pane model stays; the measure goes inside it.**
The prototype's Knowledge is a 212px sidebar (the default — it is drag-resizable, with a
double-click reset and keyboard adjust: proto:85, 2306, 4340, 4364-4368) plus a centred
column. The platform's is
a resizable three-pane workspace whose third pane is contributed by the enterprise registry.
Replacing the pane model would break `registry.panes`, `LayoutController`, the toolbar's
pane toggles and `MobileChatLayout` — for a visual result the user cannot distinguish from
the cheap version. **Decision: keep `ResizableThreePaneLayout`. Introduce the measure as a
centred, max-width column *inside* the viewer pane.** The explorer pane keeps its
`17% / 10% / 35%` sizing and its drag handle, which is a superset of the prototype's
draggable `.side`.

*Consequence:* the prototype's `.app.collapsed .wrap{padding-left:64px;padding-right:64px}`
(proto:709 — horizontal only; the shorthand form would wrongly zero the vertical rhythm)
becomes a property of the document column responding to its own available width, not to a
global "collapsed" class. Use a container query or a width observer on the column — not a global flag — because
with a chat pane open the viewer can be narrow while the explorer is open, and wide while it
is closed. The rule to implement is *"gutters grow with spare width"*, not *"gutters grow
when the sidebar is hidden"*; the prototype only ever had the second because it only ever
had two panes.

**D2 — The tree keeps every platform capability and loses only decoration.**
Drop: `Folder`/`FolderOpen` icons, the `@iconify` per-extension file glyphs, the emerald
`accent` tint on section roots. Keep: sections, `Pinned`, the loose-files divider,
inline create, rename, drag-to-move, drag-and-drop upload, the pending-upload spinner, the
context menu, auto-expand-to-open-file, and the user-intent-vs-auto-expand resolution at
`FileExplorer.tsx:427, 490-497`. `getFileIcon` (`lib/utils.ts:202`) has exactly one caller
and goes dead with the icons. **`@iconify/react` does NOT** — it has a second importer,
`apps/web/src/main.tsx:3-4`, which registers the `material-icon-theme` collection at boot.
Both packages stay in `package.json`; see WP2.

*Rationale, from the prototype (proto:3552-3559):* the folder icon repeated what the caret
said and the file icon repeated what the extension said; both stood where the name should
start. The pending spinner is the one glyph that survives, because it says something no
other part of the row says.

**D3 — One dock, two fetches. The queue is scoped to you; the per-file dot is not.**
The prototype's `KBCRS` is a mock. The real datum is `PullRequestSummary`. But it arrives
from **two different endpoints with two different scopes**, and conflating them is the
single easiest way to build WP6 wrong:

| | Endpoint | Scope | Feeds |
|---|---|---|---|
| **The dock** | `/api/workflow/change-requests/for-me` via `listPullRequestsForMe` (`git/services/pr.api.ts:26-31`) | only CRs you authored **or whose touched paths you can write** — the backend filters | the queue under the tree |
| **The dots + banner** | `/api/workflow/change-requests` via `listOpenChangeRequests` (`library/services/library.api.ts:75`) | **every** open CR | the tree dot, the tab dot, the page banner |

The dock's own copy says which one it is — "Change requests for you", "Nothing waiting for
your review" (`PullRequestsForMe.tsx:152, 169`). That scoping is correct **for a queue** and
wrong **for a signal**: a colleague's open CR on a file you can read but not write would
silently get no dot, and the same file would show a CR marker in the Library and none in
Knowledge. The broad endpoint is already on the wire and already consumed —
`useLibraryData.ts:76` uses it for exactly this purpose — so parity, not scope creep, is the
argument for reusing it.

**Decision: restyle `PullRequestsForMe` in place as the dock — changing nothing about its
fetching, its 60s poll, its vanished-branch pruning or its `PR_STALE_EVENT` handling — and
give the per-file signal its own hook on the broad endpoint.** There is no second queue *UI*;
there are two questions, and they take two fetches.

**D3a — `touchedNodePaths` is in a different path space than everything you would match it
against.** It is **KB-repo-relative** (`Knowledge/Foo.md`) — the field's own docstring says
so (`packages/shared/src/git/pr.types.ts:44`, "Relative paths within `knowledge-base/`"),
because the backend produces it with `git diff --name-only` inside the KB clone. The tree,
the tabs and `openFilePath` are **workspace-relative** and carry the `kbDirName` prefix
(`knowledge-base/Knowledge/Foo.md`); `useFileAccess` has to strip that prefix before calling
the backend for exactly this reason. A `Set` built straight from `touchedNodePaths` and
tested against tree paths matches **zero rows** — and per §8.9 a degraded CR signal renders
nothing, so the bug ships silently. The conversion belongs in one place: the hook (WP6).

**D4 — History and Compare move behind `⋯`; Content stops being a tab.**
The prototype's page has one body and an overflow menu. The platform's `activeTab` state
already exists (`FileViewer.tsx:129`) and both panels are real components. Fold the trio:
`Content` is the page; `⋯ → Version history` and `⋯ → Compare versions` set `activeTab`, and
the panel renders in place of the body with a way back. `historyAvailable` still gates both
(`FileViewer.tsx:150`). *Deviation from prototype, flagged:* the prototype has no Compare —
we keep it because it is a real feature with a real entry point today, and silently removing
it would be a regression dressed as a redesign.

**D5 — The rail renders only facts the client can prove.**
`Path` is local. `Access` comes from `useFileAccess` — the same hook the
`AccessRestrictedBanner` and `NodeOwnersBanner` already use. `Edited` comes from
`git.fetchFileHistory(path, 1)` — a **context method** (`git/state/git.context.ts:57`), so
the rail can call it directly; but note there is no shared cache and no hook, so this is one
additional request per file opened with the rail up, and `FileHistoryPanel` will fetch the
same history again if you then open it. Acceptable; just not free, and not the "already
fetched" freebie an earlier draft of this plan implied. **`Size` is the one row that cannot
be honest** — see §4.3's gap note. **`Links out` means the links this
document makes, not backlinks** — the prototype's own label, and the honest reading:
outbound links are parseable from the content we are already rendering, backlinks would need
an index that does not exist. If a backlink index ever lands, the rail gains a second
section; it does not change this one.

**D6 — The Library's measure moves to meet Knowledge, in one line.**
`LibraryLayout`'s `<main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">`
(`LibraryLayout.tsx:106`) gains the shared measure. This is the only file outside
`modules/workspace/` that this plan modifies for layout, it is one attribute, and it is the
entire reason the prototype's `.wrap`/`.wrap.wide` split exists. Ship it in WP1 together
with the Knowledge side so the two surfaces are never mismatched on a merged commit.

**D7 — No new module CSS unless Tailwind genuinely cannot express it.**
`library.css` (120 lines) is the precedent: it survives only for animation keyframes and
diff marks. Knowledge needs at most the tab-strip scrollbar suppression
(`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`) and, if the document column
uses one, the container-query declaration. Everything else is utilities. A new
`modules/workspace/workspace.css` is permitted **only** for those; it must open with a
comment saying why each rule cannot be a utility.

---

## 4. Contracts

### 4.1 Routes — unchanged

| Path | Renders | Change |
|---|---|---|
| `/workspace` | `KnowledgeSurface` → `AppLayout(CORE_PANES + registry.panes)` | none |
| `/workspace/:branch/*` | `FileRoute` → `FileViewer` | none |
| `/workspace` (no branch) | `FileViewer` empty state | none |
| everything else | — | none |

`kbFileUrl`, `kbNodeUrl`, `useCanonicalFileUrl`, `useFileNav`, `useNodeIdNav`,
`resolveRelativePath`, `stripJunkBeforeKbDir`, `NODE_ID_LINK_RE` — **all frozen.** They are
consumed by `MarkdownRenderer`, `HtmlRenderer`, `MobileChatLayout` and the enterprise
citation renderer.

### 4.2 New component contracts

Every one lives under `packages/core-frontend/src/modules/workspace/components/`.

```ts
// KbDocumentShell.tsx — the measure (WP1)
export interface KbDocumentShellProps {
  /** Widens the column and opens the second track for the rail. */
  rail?: ReactNode;
  /**
   * 'prose'      — the shell scrolls, holds the 880/980 measure and the gutters.
   *                For renderers that produce a document: markdown, text, docx,
   *                the HTML source view.
   * 'full-bleed' — the shell yields: no measure, no bottom rhythm, and it gives
   *                its child a DEFINITE height instead of scrolling it. For
   *                renderers that are already a fixed-height viewport of their
   *                own: pdf (an `h-full` iframe that collapses to 0 in an
   *                auto-height column), image, csv, xlsx, the html sandbox
   *                iframe, and the tool form (whose `w-72` aside does not fit
   *                inside 880px minus gutters).
   * The caller picks from the extension, via the same map `getFileRenderer`
   * uses (`renderers/index.ts`). Getting this wrong does not type-error — it
   * renders a zero-height PDF.
   */
  variant?: 'prose' | 'full-bleed';
  /**
   * Lands on the element that ACTUALLY scrolls. `FileViewer` passes
   * `editorContainerRef` here: a capture-phase scroll listener is bound to it
   * and is the only thing resetting the file lock's idle-release timer for a
   * user who is reading rather than typing. Scroll events do not bubble, so a
   * ref on a wrapper nested inside the scroller never fires. See WP1.
   */
  scrollRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}
```

```ts
// KbPageHeader.tsx — the title block and the page's actions (WP4)
export interface KbPageHeaderProps {
  path: string;                       // workspace-relative
  /**
   * `boolean | null` — NOT boolean. `useFileAccess` returns null while the
   * lookup is in flight, null when there is no path / kbDirName / workspaceId,
   * and null through the branch-bootstrap window; on error it deliberately
   * falls back to `true`. Only a hard `false` may hide Edit — treating null as
   * false flickers the button out on every file open.
   */
  canWrite: boolean | null;
  editMode: boolean;
  entering: boolean;                  // "Loading…" while the lock is acquired
  lockedBy: string | null;            // disables Edit and explains why via title
  railOpen: boolean;
  historyAvailable: boolean;
  /* The three chips the deleted h-10 strip used to carry, plus the tab state.
     `isReviewingPending` is not decoration: today it GATES the Edit button
     (`FileViewer.tsx:688`), and `FileViewer.test.tsx:283-284` asserts the
     badge and the button's absence together. Dropping it breaks that test. */
  isDirty: boolean;                   // → "Unsaved" badge
  waitingOnAgentUpdate: boolean;      // → "Agent update waiting" badge
  isReviewingPending: boolean;        // → "Reviewing agent update" badge, AND no Edit
  activeTab: 'content' | 'history' | 'compare';
  onEdit(): void;
  onDone(): void;
  onToggleRail(): void;
  onOpenHistory(): void;
  onOpenCompare(): void;
  onShare(target: 'file' | 'folder'): void;
  onCopyPage(): void;                 // page as Markdown
  onCopyLink(): void;                 // canonical URL, via useCanonicalFileUrl
  onCopyPath(): void;
  onViewRaw(): void;
}
```

```ts
// KbFileRail.tsx — "About this file" (WP5)
export interface KbFileRailProps {
  path: string;
  /**
   * UTF-16 code units of the loaded text, or null when unknowable (binary, or
   * not yet loaded). NOT bytes — see §4.3's gap note for why the row is
   * labelled "Characters", not "Size".
   */
  charCount: number | null;
  lastCommit: { author: string; relative: string } | null;
  /* Spelled out rather than `ReturnType<typeof useFileAccess>`: importing a
     hook into a props type couples the rail to the hook's whole shape, and
     three of that shape's five fields are nothing to do with the rail. */
  owners: AccessEligible;
  linksOut: { label: string; target: string }[];   // derived from content, may be []
  onOpen(target: string): void;
}
```

```ts
// KbChangeRequestDock.tsx — the queue under the tree (WP6)
// Renders PullRequestsForMe's data in the prototype's chrome. Same props-free
// shape as the component it replaces in the explorer's footer slot.
```

```ts
// useOpenChangeRequests.ts — the per-file signal (WP6)
//
// The seam where D3a's two path spaces meet. `touchedNodePaths` arrives
// KB-repo-relative (`Knowledge/Foo.md`); the tree, the tabs and `openFilePath`
// are workspace-relative (`knowledge-base/Knowledge/Foo.md`). This hook does
// the conversion ONCE, on ingest, by prefixing `kbDirName` from
// `useWorkspace()` — and returns an empty set while `kbDirName` is null rather
// than a set that silently matches nothing.
//
// It fetches `listOpenChangeRequests()` (ALL open CRs), NOT the dock's
// `listPullRequestsForMe()` (scoped to you) — see D3.
//
// Consumed by the tree (every row), the tab strip (every tab) and the viewer
// banner. Those are three subtrees, so the hook must be backed by ONE fetch
// shared through context — a plain hook called per row gives every tree row
// its own request and its own timer.
export interface OpenChangeRequests {
  /** Workspace-relative, kbDirName-prefixed paths with ≥1 open request. */
  paths: ReadonlySet<string>;
  /** The requests touching one workspace-relative path, for the page banner. */
  forPath(path: string): PullRequestSummary[];
}
```

### 4.3 Every datum the new UI renders, and where it already comes from

**This section is the proof that no backend work is required. Verify each row before
building the surface that consumes it; if one is wrong, that surface is deferred, not
faked.**

| Datum | Surface | Source | Verified |
|---|---|---|---|
| basename, parent dir | title block | `openFilePath` | `FileViewer.tsx:604-606` |
| canonical URL | Copy link | `useCanonicalFileUrl(openFilePath)` | `kb-routes.ts:119-144` |
| can the caller write | Edit / Share gating | `useFileAccess(path, branch).canWrite` — **`boolean \| null`**; only a hard `false` hides Edit | `useFileAccess.ts:6-13` |
| owners | rail "Access" | `useFileAccess(...).owners` (`AccessEligible`) | `FileViewer.tsx:615`, `useFileAccess.ts:15-20` |
| lock holder | Edit disabled + reason | `fileLock.externalLock.holderName` | `FileViewer.tsx:704` |
| character count | rail | `openFileContent.length` — **UTF-16 code units, not bytes**; null for binary | `workspace.context.ts:73` |
| last edit + author | rail "Edited" | `git.fetchFileHistory(path, 1)` — a context method, callable directly. **One extra request per file open**, no shared cache; `FileHistoryPanel` will refetch the same history if opened. | `git/state/git.context.ts:57` |
| links out | rail | `!href.startsWith('http') && !href.startsWith('#') && /\.md(#\|$)/.test(href)` — the real internal-link predicate | `KbMarkdownView.tsx:239` |
| open CRs, per path | tree dot, tab dot, page banner | `listOpenChangeRequests()` → `touchedNodePaths`, **KB-repo-relative**, prefix `kbDirName` before matching (D3a) | `library.api.ts:75`; `pr.types.ts:44-45` |
| CR number / title / author / file count | dock rows | `number`, `title`, `appAuthor?.name`, `touchedNodePaths.length` — `appAuthor` is **optional**, fall back to `author.login` | `pr.types.ts:16-46` |
| open a CR | dock row click | `usePrViewer()` — already wired | `PullRequestsForMe.tsx:7` |

**The gaps, stated honestly.** Three, not one:

1. **`Size` cannot be honest, so the rail does not claim it.** `openFileContent` is a
   `string`, so `.length` is UTF-16 code units — an em-dash, an accented name or an emoji
   makes it diverge from bytes, and the prototype's row reads "12 KB". Binary renderers do
   not hold the content at all. **Decision: label the row `Characters` and show it only for
   loaded text; never render a byte figure the client cannot compute.** If a real byte size
   is wanted later it is a `stat` field on an existing endpoint — small, but backend work,
   and therefore out of this plan.
2. **`Edited` costs a request.** Reachable without a refactor, but not free (above).
3. **The rail's `Access` row and `NodeOwnersBanner` are the same fact.** WP7 removes the
   banner; until it does, WP5 ships a duplicate. Land them in order or accept one release
   with both.

---

## 5. Work packages — build in this order

Each is independently shippable, independently verifiable, and independently revertable.
Do not start a WP before its dependencies have landed.

| WP | What | Depends on | Files touched | Visible on merge? |
|---|---|---|---|---|
| **WP1** | The measure, the gutters, the scroll contract | — | 7 — the shell, `FileViewer`, `LibraryLayout`, **and four renderers** | yes — immediately |
| **WP2** | The tree | — | 3 | yes |
| **WP3** | The tab strip | — | 2 | yes |
| **WP4** | The title block and the page's actions | WP1, WP3 | 4 (6 if copy-confirmation option (b)) | yes |
| **WP5** | The rail | WP1, WP4 | 3 | yes |
| **WP6** | The change-request dock and the dots | WP2, WP3 | 6 | yes |
| **WP7** | Chrome parity | WP4, WP5 | 5 | yes |

**WP1 is bigger than it looks.** "Add a max-width" is one line; *"the column scrolls"* is a
change to four renderers plus the file lock's activity source. Budget it as the largest WP
here, not the smallest.

WP1, WP2 and WP3 are disjoint and may run concurrently. WP5 and WP6 may run concurrently
after their dependencies. WP7 lands last because it cleans up what the earlier WPs displace.

---

### WP1 — The measure, the gutters, and the scroll contract

**Goal.** One column width across Knowledge and Skills; gutters that grow with spare width;
and a single, explicit answer to "who scrolls" that does not cost the file lock its
activity signal or a PDF its height.

**Build.**
1. `components/KbDocumentShell.tsx` (NEW) — the centred column. Base measure **880px**;
   **980px** with a rail, laid out as `minmax(0, 620px)` + `296px` with a `44px` gap
   (proto:344-345). Sides `40px`, bottom `110px` (proto:137). **Top padding is `12px`, not
   34px** — Knowledge overrides the app default (`.wrap.kb`, proto:699); see the note under
   §1's table.
2. **Where the shell starts is a decision, and the prototype has already made it.** In the
   prototype the tab strip is INSIDE the measure: `#main.wrap` (proto:1532) has
   `kbTabsHtml()` as its first child (proto:3776), and proto:700-705 states the rule —
   *"ONE column holds tabs, title and text at the same width, so they share an edge and the
   whole page reads as a single centred block."* So mount the shell **around `EditorTabs`
   too**, not just the renderer. Its 12px top then sits above the tabs, and the tabs carry
   the `18px` gap to the content (`.kbtabs{margin:0 0 18px}`, proto:712 — WP3's job).
3. **`FileViewer.tsx:847` is not a bare div.** It reads
   `<div ref={editorContainerRef} className="flex-1 overflow-hidden p-4">`, and
   `FileViewer.tsx:531-541` binds a **capture-phase** `scroll` listener to that exact
   element which calls `fileLock.recordActivity()`. That is the only thing resetting
   `IDLE_RELEASE_MS` (**120_000** — `useFileLock.ts:24`) for someone who is *reading* rather
   than typing. Scroll does not bubble, and a capture listener fires only on ancestors of
   the target, so **`editorContainerRef` must land on whatever element actually scrolls
   after the move** — pass it through `scrollRef` (§4.2). Put it on a wrapper nested inside
   the new scroller and the listener never fires, nothing type-errors, and locks silently
   drop out from under readers after two minutes.
   *(While you are here: the comment at `FileViewer.tsx:281` says "Idle for 30s?" against a
   120s constant. Fix the comment.)*
4. **The scroll contract, per renderer.** Nothing at the viewer level scrolls today —
   `:847` is `overflow-hidden` and every renderer owns its own scroller. So "the scroll
   container moves" is a change to the renderers, and it must not be applied to all of them:

   | Renderer | After WP1 | Why |
   |---|---|---|
   | `KbMarkdownView` (`:280` `flex-1 overflow-auto`, takes a `containerRef`), `TextRenderer`, `DocxRenderer` (`:80`), HTML **source** view | surrender scroll; become auto-height inside `variant="prose"` | they produce a document, and the document is what the measure is for |
   | `PdfRenderer` (`:78` `w-full h-full` iframe), `ImageRenderer` (`:42`), `CsvRenderer` (`:103,130`), `XlsxRenderer`, `HtmlRenderer` sandbox iframe (`:222`), `ToolRenderer` (`:271,295,320` — two columns with a fixed `w-72` aside) | keep their own scroller; shell renders `variant="full-bleed"` and gives them a definite height | an `h-full` iframe in an auto-height column collapses to 0px, and an 880px prose measure is wrong for a spreadsheet |

   `KbMarkdownView` also uses its `containerRef` for heading deep-link scrolling
   (`MarkdownRenderer.tsx:123-136`) — that ref must follow the scroller too, or `#anchor`
   links stop working.
5. Gutters: `clamp`-style padding that grows with the column's own available width, per
   D1. Floor at the prototype's `40px`, ceiling at its `64px`.
6. `LibraryLayout.tsx:106` — `<main>` gains the same measure (D6).

**Do not touch.** The `editorContainerRef` scroll-activity listener (`FileViewer.tsx:527-541`)
and everything it feeds in `useFileLock`. Move the element; keep the wiring.

**Verify.** With the explorer open and closed, and with the chat pane open and closed:
the document column's left edge is the same distance from the pane edge as the Library
page's h1 is from its pane edge, at the same window width. Prose never exceeds ~75
characters. Nothing horizontally scrolls. **Open a PDF, an image and a CSV** — each fills
its pane at full height, none collapses. **A heading deep-link (`…#goal`) still scrolls.**
**In edit mode, scrolling the document resets the idle timer** — there is no test for this
today (`FileViewer.test.tsx` has zero scroll/`recordActivity` coverage), so WP1 adds one:
render in edit mode, fire `scroll` on the new container, assert `recordActivity` fired.

---

### WP2 — The tree

**Goal.** `FileExplorer`'s rows become the prototype's rows, losing nothing but decoration.

**Build.**
1. Row chrome → the prototype's (proto:684-693) and, equivalently,
   `GroupsSidebar`'s `rowClass` (`GroupsSidebar.tsx:68-72`): `text-ui`, `text-ink-muted`,
   `rounded-sm`, `px-2.5 py-1.5`, `gap-1.5`, hover `bg-hover text-ink`,
   `aria-current` → `bg-hover text-ink font-semibold`.
2. Delete the `Folder` / `FolderOpen` icons and the `<Icon icon={material-icon-theme:…}>`
   file glyph (`FileExplorer.tsx:598-607, 783-789`). Keep the caret, and **render it only
   when the directory has children** (proto:3565) — an empty folder has nothing to open.
   Keep the `Loader2` pending spinner.
3. Delete the `accent` prop and its emerald classes; the **seven** section calls at
   `FileExplorer.tsx:1034, 1037, 1040, 1043, 1046, 1049, 1052` drop the flag.
4. Indent → `10 + depth * 13`; the file row's `+18` compensation disappears with the icon,
   and the empty caret slot (`.tw`, 13px) is what keeps names aligned (proto:3571-3572).
5. `ContextMenu` (`:90-256`) → `MenuPanel` / `MenuItem`. Same items, same order, same
   handlers, **plus one new item — `Copy path`** (§1 row 14: it is the only prototype
   context-menu item the platform lacks; proto:3948 writes the path and toasts "Path
   copied."). `Delete` keeps its danger tone via the primitive, not `text-red-600`.
   `MenuPanel` is presentation-only (§2.3) — this WP owns the outside-click close, the
   Escape close and returning focus to the row.
6. Add the a11y handles the tree has never had (§2.3): `aria-expanded` on directory rows,
   `aria-current` on the open file's row, `aria-label` on the hover-reveal icon buttons.
7. `InlineInput` / `RenameInput` → `TextField`, keeping the validation message and the
   `onBlur`-submits-if-valid behavior (and the alert-loop guard at `:711-717`).

**Do not touch.** Drag/drop, upload dispatch, `snapshotEntries`, pin storage, auto-expand,
`findKbRoot`, the sections `useMemo`, `PullRequestsForMe`'s mount point.

**One thing goes dead, and one thing does not.**
- `getFileIcon` (`lib/utils.ts:202`) has exactly one caller — `FileExplorer.tsx:762`.
  Delete it with its last use; a helper nothing calls is a trap for the next reader.
- **`@iconify/react` stays.** It has a second importer: `apps/web/src/main.tsx:3-4` calls
  `addCollection()` with `@iconify-json/material-icon-theme/icons.json` to register the
  collection at boot. Both packages remain declared in `apps/web/package.json:15-16`.
  Removing `FileExplorer`'s `Icon` import leaves that registration paying for a collection
  nothing renders — a follow-up worth raising, but it is a dependency decision spanning
  `apps/web`, not this WP's call.

**Verify.** `FileExplorer.test.tsx` passes with selectors that no longer depend on an icon.
Deep-linking to a nested file still reveals its row. A folder with no children shows no
caret and does not toggle. Right-click offers `Copy path`, and Escape closes the menu.

---

### WP3 — The tab strip

**Goal.** `EditorTabs` becomes `.kbtabs`.

**Build.**
1. Strip: transparent (not `bg-sunken`), `border-b border-line`, horizontal scroll with the
   scrollbar suppressed (D7's one CSS exception), `gap-0.5`.
2. Tab: `text-detail`, `text-ink-faint`; hover `bg-hover text-ink-muted`; active
   `text-ink font-semibold` + `shadow-[inset_0_-2px_0]` in `ink`. Radius `sm` on the top
   corners only.
3. Close `×`: **already correct** — `opacity-0 group-hover:opacity-100 focus:opacity-100`
   (`EditorTabs.tsx:274`). The only change is `focus:` → `focus-visible:`, so it does not
   pop on a mouse click. Do not rewrite the rest of it.
4. Leave a slot before the label for WP6's CR dot.
5. Add `aria-current` to the active tab (§2.3 — the strip has `role="tablist"` at `:43` but
   no per-tab current state today).
6. **Scroll-into-view on activation.** The strip suppresses its scrollbar, which removes the
   only cue that more tabs exist off-screen — and there is no scroll-into-view today
   (`EditorTabs`' single `useLayoutEffect` at `:296` positions the context menu, nothing
   else). Shipping the suppression without this makes a 20-tab strip worse than it is now.
   Either add `scrollIntoView({ inline: 'nearest', block: 'nearest' })` when the active tab
   changes, or keep the scrollbar. Not neither.

**Do not touch.** Reorder-by-drag, the close→navigate handshake (`EditorTabs.tsx:55-68`),
the unsaved-changes bulk warning, the tab context menu.

**Verify.** `EditorTabs.test.tsx` green. Keyboard: tab to a tab, `focus-visible` shows its
close button, `Enter` activates. With more tabs than fit, activating an off-screen tab
brings it into view.

---

### WP4 — The title block and the page's actions

**Goal.** The 40px chrome strip becomes a document title with the page's actions beside it.

**Build.**
1. `components/KbPageHeader.tsx` (NEW), contract in §4.2. Layout: `<h1>` (`text-display`,
   `font-semibold`, basename minus a known extension) + a right-aligned action row.
2. Actions, in the prototype's order and weight (proto:3785-3803):
   - **Share** — bounded, bordered, `text-detail`, with a chevron half opening a menu:
     `Manage access…` · `Copy link to this page` · `Share the whole folder`. All three
     land on the existing `ManageAccessDialog` (file target, or the parent directory) or
     the clipboard. The chevron exists here and **not** on the Library's group Share
     because a file has two share scopes and a group has one.
   - **Copy page as Markdown** — icon button.
   - **Edit / Done** — icon button; `Done` while in edit mode. Same handlers, same lock
     semantics, same disabled reasons. **Preserve the render gate verbatim** —
     `!onProtectedBranch && !isReviewingPending && activeTab === 'content'`
     (`FileViewer.tsx:688`). Dropping `isReviewingPending` breaks
     `FileViewer.test.tsx:283-284`, which asserts the review badge and the button's
     absence in the same case.
   - **`⋯`** — `File details` (toggles the rail) · `Version history` · `Compare versions` ·
     `View raw file` · `Copy path`. History and Compare hidden when
     `historyAvailable === false`. Like the tree's menu, this one and the Share chevron own
     their own outside-click / Escape / focus-return — `MenuPanel` provides none of it (§2.3).
3. Delete the `h-10` strip (`FileViewer.tsx:618-717`) and the `TabButton` component
   (`:884-906`). The three chips move to the title row as `Badge`s, driven by the props
   §4.2 now carries for them: `isDirty` (`FileViewer.tsx:627`), `waitingOnAgentUpdate`
   (`:633`), `isReviewingPending` (`:639`).
4. **Decide how a copy reports success, before deleting the thing that does it today.**
   Every copy in the prototype answers with a toast (`copyNow` → `toast`, proto:2809-2812;
   "Link copied." :3934, "Path copied." :3948). The platform has no toast on `/workspace`
   at all — `LibraryToastProvider` is mounted in exactly one place, `LibraryRoutes.tsx:30`.
   Knowledge's only copy confirmation is the inline "Link copied" tooltip at
   `FileViewer.tsx:671-680` — inside the strip step 3 deletes. Two options:
   - **(a) Keep it local.** `KbPageHeader` holds per-action `copied` state and flashes it on
     the button that was clicked, reusing the existing pattern (`FileViewer.tsx:54`,
     `:558-560`). No new file, no shell change, WP4 stays at 4 files. **Recommended.**
   - **(b) Match the prototype.** Promote `modules/library/state/toast.tsx` to a shared
     provider mounted in `CoreAppShell` above both route trees. Note this adds
     `core/CoreAppShell.tsx` and a `shared/components` entry to §6 — files this plan
     otherwise does not touch — and that §2.2 then applies to `toast.tsx`, which carries
     `border-[#7fd0c4]`, `text-[#0f766e]` and `text-[12.5px]` at `:34`. Fixing those on the
     way through lowers the ratchet; re-mounting alone moves nothing.
   Whichever is chosen, `onCopyPage` / `onCopyLink` / `onCopyPath` are responsible for
   reporting **failure** as well as success — `navigator.clipboard` rejects on a
   non-secure origin, and a silent no-op is the worst answer.
5. `activeTab` stays as state; `history` and `compare` now render in place of the body,
   each with an explicit way back to the document.

**Do not touch.** `handleEnterEditMode` / `handleExitEditMode` / `handleSave` and their
comments — they encode two real races (`:299-324`, `:417-440`). Move the *buttons*.
The pending-review flow (`isReviewingPending`, `handleAccept`, `handleReject`,
`pendingDeferred`, the `hasPendingReview` suppression) keeps its logic; only its chrome
moves.

**Verify.** `FileViewer.test.tsx` green with relocated selectors and every prior assertion
intact — including `:283-284`. Edit on a locked file is disabled and its `title` names the
holder. On a protected branch there is no Edit and no Share-edit affordance. A copy reports
back, and reports a failure too.

---

### WP5 — The rail

**Goal.** "About this file", from facts we can prove (D5).

**Build.**
1. `components/KbFileRail.tsx` (NEW) — `About this file`: `Path` (mono, wrapping — never
   truncated; a truncated path defeats the one thing anyone copies a path for),
   **`Characters`** (not "Size" — §4.3 gap 1; omitted when null), `Edited`
   (`{relative} by {firstName}`), `Access` (a `Badge` from the `owners` prop); then
   `Links out` — buttons that call `openFile`.
2. `hooks/useLinksOut.ts` (NEW) — parse outbound internal links from the active file's
   content with the predicate at **`KbMarkdownView.tsx:239`** —
   `!href.startsWith('http') && !href.startsWith('#') && /\.md(#|$)/.test(href)`. (An
   earlier draft cited `MarkdownRenderer.tsx:158`; that is a branch *inside* a click
   handler which only splits already-classified links into absolute-vs-relative, and it
   filters nothing.) Returns `[]` for non-markdown, which renders as no section rather than
   an empty one.
3. `Edited` calls `git.fetchFileHistory(path, 1)` directly (`git/state/git.context.ts:57`).
   One request per file opened **with the rail up** — gate the call on rail visibility so a
   closed rail costs nothing.
4. Rail visibility is session state, defaulting **closed**, toggled from `⋯ → File details`.
   Open ⇒ `KbDocumentShell` switches to the wide measure. Under 900px the rail stacks below
   the article, never beside it (proto:633 collapses `.item-grid` to one column).

**Verify.** The rail never shows a row it cannot fill. Toggling it changes the column width
and nothing else. A closed rail issues no history request. `NodeOwnersBanner` and the rail
do not both claim the owners — WP7 removes the banner; if WP5 ships first, that one release
shows both.

---

### WP6 — The change-request dock and the dots

**Goal.** The queue reads like the prototype, and a file that has an open request says so
in all three places it should.

**Build.**
1. `components/KbChangeRequestDock.tsx` (NEW) — the prototype's chrome (proto:730-750):
   a disclosure header `CHANGE REQUESTS` with a caret and an amber count `Badge`, then rows
   `#{number}` + title (ellipsis on the text, never on the flex row — proto:745-747) +
   `{author} · {n} file(s)`. Pinned to the explorer's footer with a `border-t`.
2. **The dock renders `PullRequestsForMe`'s own data — nothing more.** Its fetch/poll/prune
   is entangled with component-local state (`prs`/`loading`/`error` plus `timerRef`,
   `mountedRef`, `prevBranchesRef`, and a single effect at `:37-140` owning the 60s timer,
   the `visibilitychange` handler, the `PR_STALE_EVENT` listener and the vanished-branch
   prune). "Behavior-identical extraction" of that into a plain hook is optimistic — a hook
   called from two places would run the prune twice. **Default: restyle the component's
   markup in place and extract nothing.** If the dock must be a separate file for §2.1
   seam 2 reasons, wrap rather than extract.
3. `hooks/useOpenChangeRequests.ts` (NEW) — §4.2 contract. **Three things this must get
   right, none of which fail loudly:**
   - **Different endpoint from the dock.** Fetch `listOpenChangeRequests()`
     (`library/services/library.api.ts:75` → `GET /api/workflow/change-requests`, every
     open CR), **not** `listPullRequestsForMe()`. Per D3, the dock is scoped to you and the
     dot is not; using the dock's data would hide a colleague's CR on a file you can read
     but not write, and make a Knowledge dot mean something different from a Library dot.
   - **Convert the path space on ingest.** `touchedNodePaths` is KB-repo-relative; the tree,
     tabs and `openFilePath` are workspace-relative. Key the set as
     `` `${kbDirName}/${p}` `` with `kbDirName` from `useWorkspace()`, and return an **empty
     set** while `kbDirName` is null rather than one that matches nothing (D3a).
   - **One fetch, shared.** The tree (every row), the tab strip (every tab) and the viewer
     banner are three subtrees. Back the hook with a context provider mounted once in the
     Knowledge surface — a plain hook per consumer gives every tree row its own request and
     its own timer.
4. Tree dot: 6px, `bg-wait-dot`, `ml-auto`, `title="Open change request"` (proto:692).
5. Tab dot: 6px, `bg-accent`, before the label (proto:723) — a different colour on purpose:
   in the tree it is news about a file you are not looking at; on a tab it marks the one
   you are.
6. Page banner: `Banner tone="wait"` above the body — "Open change request" + who proposed
   it + a `Review the change` button opening the existing PR viewer (proto:3805-3809).

**Verify.** The decisive case, because a path-space bug renders nothing and looks like
"no open requests": **a CR whose `touchedNodePaths` entry is `Knowledge/Foo.md` must light
the tree row whose `relativePath` is `knowledge-base/Knowledge/Foo.md`.** Assert it in a
test with those two literal strings, not with a fixture that shares one path space.

Then: a CR opened by **someone else**, on a file you can read but not write, shows the dot
and the banner (that is the D3 split working) while the dock stays empty (that is the dock's
scoping working). Zero change to the dock's poll interval, pruning, or `PR_STALE_EVENT`.
Opening the tree with the CR provider mounted issues **one** request, not one per row.

---

### WP7 — Chrome parity

**Goal.** Everything the earlier WPs displaced, retypeset; nothing left saying two things.

**Build.**
1. `Toolbar.tsx:62-74` — the explorer toggle uses `SidebarToggle`'s `PanelGlyph` instead of
   lucide `PanelLeft`, so both surfaces show one glyph in one spot (proto:3696).
2. The five inline banner strips in `FileViewer` → `Banner` with the right tone. **Four
   carry a raw palette** (`:734`, `:777` amber; `:791`, `:827` red); the fifth (`:752`,
   Accept/Reject) is already on `bg-sunken`/`border-line-strong` and moves for shape, not
   for the ratchet. The validator `mustFix` list keeps its structure and its 20-item cap.
3. `NodeOwnersBanner` — decide against the rail (WP5) and remove the duplicate.
4. The empty state (`:566-602`) — `text-head` heading, `text-ui text-ink-muted` body,
   suggested prompts as `Surface` rows. Keep the `seedSuggestedPrompt` registry gate.
5. `FileRoute`'s four full-screen error states (`:287-389`) — `Banner` + tokens; keep every
   sentence, including the dirty-branch explanation.
6. Sweep the ratchet: `modules/workspace/` holds **17** raw-palette occurrences
   (`bg-amber-50`, `bg-red-50`, `text-emerald-*`, `border-red-200`, `bg-emerald-*`) plus its
   share of the off-scale and bare-`rounded` balances. Retire them, then re-baseline once,
   downward.

**Verify.** Measured against the ACTUAL counts, not the stale baseline (§2.2): run
`node scripts/design-system-ratchet.mjs` before and after and require every counter to fall.
Zero `bg-amber-50`, `bg-red-50`, `text-emerald-*`, `bg-emerald-*` or `border-red-200`
remains under `modules/workspace/`.

---

## 6. File-by-file work plan

### CREATE — all under `packages/core-frontend/src/modules/workspace/`

| File | WP | Contents |
|---|---|---|
| `components/KbDocumentShell.tsx` | 1 | the measure; §4.2 contract |
| `components/KbPageHeader.tsx` | 4 | title + actions; §4.2 contract |
| `components/KbFileRail.tsx` | 5 | About this file + Links out; §4.2 contract |
| `components/KbChangeRequestDock.tsx` | 6 | the dock; prototype chrome over real PR data |
| `hooks/useLinksOut.ts` | 5 | outbound internal links, predicate from `KbMarkdownView.tsx:239` |
| `hooks/useOpenChangeRequests.ts` | 6 | workspace-relative path → open requests; owns the `kbDirName` conversion (D3a) |
| `state/open-change-requests.tsx` | 6 | the provider backing that hook — one fetch shared by tree, tabs and viewer |
| `workspace.css` | 1/3 | **only** scrollbar suppression + any container-query rule; each with a comment saying why it is not a utility |

`hooks/useMyPullRequests.ts` was in an earlier draft and is **cut** — WP6 step 2 restyles
`PullRequestsForMe` in place rather than extracting a hook that would run its prune twice.

### MODIFY

| File | WP | Change |
|---|---|---|
| `components/FileExplorer.tsx` | 2, 6 | row chrome; drop folder/file icons + `accent` (7 sites); caret only when children; indent `10+13d`; `ContextMenu`→`MenuPanel` **+ Copy path**; inputs→`TextField`; `aria-current`/`aria-expanded`; CR dot; footer slot → dock |
| `components/EditorTabs.tsx` | 3, 6 | `.kbtabs` chrome; `focus:`→`focus-visible:`; scroll-into-view; `aria-current`; CR dot slot |
| `components/FileViewer.tsx` | 1, 4, 5, 6, 7 | mount `KbDocumentShell` (forwarding `editorContainerRef`); delete the `h-10` strip + `TabButton`; mount `KbPageHeader`, rail, CR banner; banners → `Banner`; empty state retypeset; fix the stale 30s comment at `:281` |
| `components/renderers/KbMarkdownView.tsx`, `TextRenderer.tsx`, `DocxRenderer.tsx`, `HtmlRenderer.tsx` | 1 | **surrender their scroll container** to the shell (WP1 step 4). Missing from an earlier draft — "the scroll container moves" is a renderer change, not a viewer change |
| `components/FileRoute.tsx` | 7 | four error states onto `Banner` + tokens |
| `../git/components/PullRequestsForMe.tsx` | 6 | restyle markup in place; **no extraction** (see §2.1 seam 2) |
| `../access/components/NodeOwnersBanner.tsx` | 7 | removed from the viewer once the rail carries owners |
| `../toolbar/components/Toolbar.tsx` | 7 | one glyph swap |
| `../library/components/LibraryLayout.tsx` | 1 | the shared measure on `<main>` (D6) |
| `lib/utils.ts` | 2 | delete `getFileIcon` (`:202`) with its last caller |
| `scripts/design-system-baseline.json` | 7 | lowered, never raised |

**Conditional, only if WP4 picks copy-confirmation option (b):**
`core/CoreAppShell.tsx` + `../library/state/toast.tsx` (promoted to `shared/`). Option (a)
touches neither — which is why it is the recommendation.

### DELETE

| Symbol / file | WP | Why it is safe |
|---|---|---|
| `TabButton` in `FileViewer.tsx` (`:884-906`) | 4 | local to that file; the tab trio moves behind `⋯` |
| `getFileIcon` in `lib/utils.ts:202` | 2 | verified single caller (`FileExplorer.tsx:762`), which goes with it |
| `components/NodeOwnersBanner.tsx` | 7 | verified single consumer (`FileViewer.tsx:615`); the rail takes over. Grep the enterprise repo first — if it mounts it, unmount here and keep the file |

Not deleted: `@iconify/react` from `package.json`. It becomes unreferenced after WP2 and
removing it is a genuine bundle win, but it is a dependency call — raise it, don't take it.

---

## 7. Test plan

New tests go beside the code they cover, following the six-directory layout the module
already uses (§2.3) — components in `components/__tests__/`, hooks in `hooks/__tests__/`,
renderer changes in `components/renderers/__tests__/`.

**New files**

- `KbDocumentShell.test.tsx`
  1. renders children inside a centred column
  2. `rail` prop opens the second track and widens the measure
  3. without `rail`, one track, narrow measure
  4. `variant="full-bleed"` drops the measure and the bottom rhythm
  5. **`scrollRef` lands on the element that scrolls** — assert the ref's `.current` is the
     node carrying `overflow-auto`, in both variants
- `KbPageHeader.test.tsx`
  1. h1 is the basename with a known extension stripped
  2. Share opens the file dialog; the chevron menu offers link + folder
  3. `canWrite: false` renders no Edit — **and `canWrite: null` still renders it** (null is
     "not known yet", not "denied")
  4. `lockedBy` disables Edit and names the holder in its `title`
  5. `⋯` offers File details / Version history / Compare versions / View raw / Copy path
  6. `historyAvailable: false` hides both history entries
  7. `editMode` swaps Edit for Done
  8. `isReviewingPending` renders the review Badge **and no Edit** (the pairing
     `FileViewer.test.tsx:283-284` already asserts)
  9. `isDirty` renders the Unsaved Badge; `waitingOnAgentUpdate` renders its own
  10. Escape closes an open menu and returns focus to its trigger
- `KbFileRail.test.tsx`
  1. renders Path, Edited and Access
  2. `charCount: null` omits the row entirely (asserted absent, not empty)
  3. empty `linksOut` renders no "Links out" section
  4. clicking a link calls `onOpen` with the target
  5. a long path is not truncated
- `KbChangeRequestDock.test.tsx`
  1. header carries the count; collapsed by default state is honored
  2. a row shows `#n`, the title, and `{author} · {n} files` with correct pluralisation
  3. zero requests renders nothing
  4. `appAuthor` absent → falls back to `author.login`, never renders "undefined"
- `useOpenChangeRequests.test.ts`
  1. **the path-space join** — `touchedNodePaths: ['Knowledge/Foo.md']` with
     `kbDirName: 'knowledge-base'` puts `'knowledge-base/Knowledge/Foo.md'` in `paths`.
     Write both literals out; a fixture that shares one path space tests nothing (D3a)
  2. `kbDirName: null` → empty set, not a set that matches nothing
  3. `forPath` returns every request touching a workspace-relative path
  4. no open CRs → empty set, no throw
  5. it calls `listOpenChangeRequests`, **not** `listPullRequestsForMe` (D3) — assert on the
     mocked module, since this is the difference between a dot and no dot for a colleague's CR
- `useLinksOut.test.ts`
  1. extracts internal markdown links
  2. ignores `http(s)` and same-page anchors
  3. non-markdown content → `[]`

**Extended (assertions preserved, selectors updated)**

- `FileExplorer.test.tsx` — add: no folder icon renders; a childless directory has no
  caret; the context menu is reachable and still deletes; a row with an open CR shows the
  dot (`title="Open change request"`).
- `EditorTabs.test.tsx` — add: active tab carries `aria-current`; the close control is
  reachable by keyboard.
- `FileViewer.test.tsx` — add: the h1 names the file; `⋯ → Version history` shows the
  history panel and offers a way back; the CR banner renders for a touched file.
  **And the one this suite has never had: scrolling the document in edit mode calls
  `recordActivity`** — there is currently zero scroll / `recordActivity` / idle-release
  coverage, which is why WP1's lock regression could ship unnoticed.
- `FileRoute.test.tsx` — unchanged assertions, `Banner` selectors.
- Renderer tests (`KbMarkdownView`, `PdfRenderer`, `CsvRenderer`) — add: the prose renderers
  no longer declare their own scroller; the full-bleed ones still do (WP1 step 4).

---

## 8. Edge cases and failure modes

1. **Narrow viewport.** The prototype collapses to a single column under 900px — the block
   opens at proto:623 (`@media (max-width:900px)`) with `.app{flex-direction:column}` at
   :624. Inside it the column takes `padding:18px 18px 90px` (proto:632 — 18px sides, and
   the bottom rhythm drops from 110px to 90px) and `.item-grid` collapses to one track
   (:633), which is what stacks the rail below the article. The platform has
   `MobileChatLayout` for the pane side of this.
2. **Chat pane open on a small window.** The viewer pane can be narrower than the measure.
   The column takes the pane's width minus the floor padding — it never overflows and never
   scrolls horizontally.
3. **Binary files.** No `Characters` row in the rail (§4.3), no `Copy page as Markdown` (the
   action hides rather than copying nonsense), no `Links out`. The shell renders them
   `full-bleed` — a PDF iframe inside a prose column collapses to zero height.
4. **A file with no extension.** The h1 shows the name verbatim; only known extensions are
   stripped.
5. **Very long path.** The rail wraps it; it never truncates a path, because a truncated
   path is unusable for the one thing anyone copies a path for.
6. **Protected branch.** No Edit, no Share-edit affordance; the `ProtectedBranchBanner`
   stays. Read-only is a state of the page, not a missing feature.
7. **Lock held by someone else.** Edit disabled with the holder named; the existing lock
   banner still explains it. Do not say it twice — the banner is the sentence, the disabled
   button is the consequence.
8. **`historyAvailable === false`** (git not ready). Both history entries vanish from `⋯`;
   the menu does not render an empty separator.
9. **CR list unavailable / degraded.** No dock, no dots, no banner — silently. A queue that
   cannot load is not an error state on a page about a document. **This is also exactly what
   a D3a path-space bug looks like**, which is why WP6's verification asserts the join with
   two literal strings instead of trusting the surface to look right.
10. **A CR touching a path the caller cannot read.** The dot renders only on rows in the
    tree, and the tree only contains what the caller can read — so the dot cannot leak a
    path. The banner only renders for the file you have open, which you can read by
    definition. The dock row's title comes from GitHub and is already visible today.
10b. **A CR from someone else on a file you cannot write.** Dot and banner: yes (the broad
    endpoint). Dock: no (it is scoped to you). That asymmetry is D3 working, not a bug —
    if a reviewer reports it as one, point them here.
11. **Tab strip with 20 tabs.** Horizontal scroll with a suppressed scrollbar. **There is
    no scroll-into-view today** — `EditorTabs`' only `useLayoutEffect` (`:296`) positions
    the context menu, not the strip — so activating a tab that is scrolled off-screen
    leaves it off-screen. The prototype does not solve this either. Suppressing the
    scrollbar makes it *worse*, because the user loses the one affordance telling them
    there is more strip. **Either add a `scrollIntoView({ inline: 'nearest' })` on
    activation as part of WP3, or keep the scrollbar.** Do not ship the suppressed
    scrollbar without one of the two.
12. **Rail open + Compare panel.** Compare owns the full column; the rail hides for the
    duration and comes back with the document.
13. **Registry-contributed renderers and panels.** The enterprise `.html` renderer override
    and `fileViewerPanels` mount exactly where they do today, inside the same relative
    container (`FileViewer.tsx:115-117, 878`).
14. **Secrets.** Knowledge renders files; if a file *contains* a secret that is a KB
    content problem, not a UI one. This plan adds no secret-bearing surface, no new fetch,
    and no logging.

---

## 9. Acceptance criteria

- [ ] Knowledge and Skills show the same column width and the same **side** gutters at the
      same window width, with the nav open and with it closed. **Top padding differs on
      purpose** — 12px in Knowledge, 34px in Skills (§1's note). Do not "fix" it.
- [ ] Every renderer is whole: a PDF, an image, a CSV and a tool form each fill their pane;
      a markdown document sits in the 880px measure; a heading deep-link still scrolls.
- [ ] **Scrolling a document in edit mode still resets the lock's idle timer**, with a test
      that proves it.
- [ ] The Knowledge tree has no folder icons and no per-extension file icons; a childless
      folder has no caret; row typography is identical to `GroupsSidebar`'s rows.
- [ ] Every tree capability survives: create, rename, delete, pin, move by drag, upload by
      drop, unzip, download, manage access, auto-expand to the open file — **plus Copy path**,
      which the platform's menu has never had.
- [ ] The tab strip underlines the active tab, reveals its close control on hover and on
      keyboard focus, marks a file with an open change request, and brings an off-screen
      active tab into view.
- [ ] The document page leads with an `<h1>` naming the file, with Share (bounded), Copy
      page, Edit (icons) and `⋯` beside it — and no 40px chrome strip anywhere.
- [ ] `⋯` offers File details, Version history, Compare versions, View raw file, Copy path;
      the two history entries hide when git is not ready.
- [ ] Share opens the existing `ManageAccessDialog`; the chevron additionally offers
      "Copy link to this page" and "Share the whole folder".
- [ ] The rail shows Path, Characters (when knowable), Edited, Access, and Links out — and
      omits any row it cannot fill. It never prints a byte figure.
- [ ] A copy action confirms itself, and reports a failure too.
- [ ] The change-request dock sits under the tree with a count, and its rows open the PR
      viewer. A touched file shows a dot in the tree, a dot on its tab, and a banner on its
      page — **including for a CR opened by someone else on a file you cannot write.**
- [ ] The dot/tab/banner join is proven by a test using two literal path strings from the
      two different path spaces (`Knowledge/Foo.md` ↔ `knowledge-base/Knowledge/Foo.md`).
- [ ] `PullRequestsForMe`'s fetch, 60s poll, branch pruning and `PR_STALE_EVENT` handling
      are behaviorally unchanged.
- [ ] Edit-mode lock semantics are unchanged: acquire-then-reload-then-flip on entry,
      optimistic on exit, with both race guards intact.
- [ ] The a11y handles §2.3 lists all exist, and the three menus close on outside click and
      on Escape.
- [ ] No route changed, no URL shape changed, no backend file changed, no migration added.
- [ ] `git diff` shows zero changes under `modules/pr/` and `modules/review/`.
- [ ] `pnpm -s typecheck`, `pnpm -s test`, `pnpm -s build` all green; the test count only
      grew.
- [ ] The **actual** ratchet counts (`node scripts/design-system-ratchet.mjs`) are lower
      than they were at `ec62b6b` — 65 / 138 / 151 — not merely under the stale baseline,
      and the baseline file is re-cut downward once at the end.

---

## 10. Risks and fallback moves

1. **`FileViewer.tsx` is 906 lines and holds four concerns** (banners, chrome, lock
   lifecycle, renderer host). WP4 moves chrome out of it and will tempt a wholesale
   refactor. **Do not.** The lock and pending-review logic carry two documented race fixes;
   a refactor that loses either is worse than a file that is too long. If the file must
   shrink, extract the *banner stack* into `KbBanners.tsx` — pure presentation, zero risk.
2. **The measure fights the resizable explorer.** A user who drags the explorer to 35% on a
   1280px window leaves the viewer at ~830px, below the 880px measure. Correct behavior is
   the column shrinking to fit with the floor padding — verify at that exact width, because
   it is the one place the two layout models genuinely disagree.
3. **The dock/`PullRequestsForMe` boundary** (§2.1 seam 2). WP6 now restyles in place and
   extracts nothing, which keeps the diff inside one component. If Ali objects to us
   touching it at all, wrap instead. Decide *before* WP6 starts, not during.
3b. **WP6 introduces the Knowledge surface's first use of a `modules/library/` service**
   (`listOpenChangeRequests`). That is the right call — it is what makes a dot mean the same
   thing on both surfaces (D3) — but it is a new cross-module edge. If that direction of
   dependency is unwanted, move the function to a shared services location rather than
   duplicating the fetch; two copies of the same endpoint call is how the two surfaces drift
   apart again.
4. **`NodeOwnersBanner` has exactly one consumer** — `FileViewer.tsx:615` (verified). So
   unmounting it in WP7 makes the component itself dead, and the rail becomes the only
   place owners are stated. That is the intent; just delete the component with its last
   use rather than leaving an orphan. The risk is only that somebody downstream mounts it
   from the enterprise package — grep that repo before deleting, and if it does, unmount
   here and leave the file.
5. **"Links out" may read as backlinks** to someone who expects a graph. The label is the
   prototype's and it is literal. If it confuses, rename to "Links in this file" — one
   constant, one test string.
6. **Icon removal is the most reversible-looking and least reversible-feeling change.**
   Somebody will miss the file icons. The prototype's argument (proto:3552-3559) is the
   answer, and it is in the code as a comment so the next reader gets it without archaeology.
   If it must be reverted, it is one prop and one import.
7. **Ratchet drift.** WP1-WP6 each touch token-heavy files; it is easy to add
   `text-[13px]` by reflex. Run `pnpm ds:check` per WP, not once at the end — a single
   end-of-branch run tells you a counter went up and not which of six WPs did it.

---

## 11. Execution mechanics

**Branch.** `knowledge-ui`, cut from `skills-and-tools-ui` at `ec62b6b`. It inherits the
design system, the primitives, the tokens and the ratchet — which is the whole reason for
cutting from there rather than from `main`.

**Cadence.** One commit per work package, in the numbered order, each with the four-command
verification loop green before it lands. Commit subjects state what changed for the reader,
not which files moved — the branch's existing history is the model
(`"A group you cannot read is still a place you can stand in"`).

**Landing.** `knowledge-ui` → `skills-and-tools-ui` when WP7 is green, so the two surfaces
merge to `main` together and no commit exists where they disagree about the measure. If
Skills & Tools ships first, WP1's `LibraryLayout` line is the only conflict, and it is a
one-line rebase.

**Do not start** WP4 before WP1 and WP3 have landed; the title block's position depends on
both, and building it against a moving column costs more than waiting.
