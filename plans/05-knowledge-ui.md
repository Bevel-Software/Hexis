# MASTER PLAN — KNOWLEDGE UI

Owner: **Juan**. Repo: `/Users/empire23/CodeBases/skill-and-tool-management`.
Branch: **`knowledge-ui`**, cut from `skills-and-tools-ui` (which carries the design system,
the primitives barrel, the token file and the ratchet).
Executors: autonomous coding agents. **Read this file in full before opening any source file.**

Source of truth for the design: `skill-prototype-juan.html` (the approved prototype),
Knowledge surface — `#app=kb`. Every line reference below of the form `(proto:NNN)` is a
verified line in that file at the commit this plan was written against (`ec62b6b`).
Every `path.tsx:NN` reference was likewise verified to exist.

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
| 1 | **Document measure** | `.wrap{max-width:880px;padding:34px 40px 110px}`, `.wrap.wide{max-width:980px}` when the rail is up (proto:137-138) | Viewer pane is `flex-1 … p-4`; the renderer runs the full pane width (`FileViewer.tsx:847`) | **Adopt.** A 2000px line of prose is not a reading surface. |
| 2 | **Collapsed gutters** | `.app.collapsed .wrap{padding-left:64px;padding-right:64px}` (proto:709) — hiding the nav buys margin, not line length | Collapsing the explorer pane hands every reclaimed pixel to the text | **Adopt.** |
| 3 | **Tree rows** | Name + one caret. No folder icon, no file icon. 13px/`--ink2`, radius 7, `6px 10px`, indent `10 + depth*13` (proto:683-693, 3560-3580) | Chevron + `Folder`/`FolderOpen` lucide icon + `@iconify` material-theme per-extension file glyph; roots tinted emerald; indent `12 + depth*16`, files `+18` (`FileExplorer.tsx:472, 598-607, 783-789`) | **Adopt the prototype.** The caret is the only actionable thing in the row; the extension already says what a `.csv` is. |
| 4 | **Tree ↔ Library sidebar parity** | One typographic system across both sidebars — explicitly (proto:680-682) | `.trow` and `GroupsSidebar`'s `rowClass` disagree on size, weight, radius, padding and hover | **Adopt.** Rows become the same component vocabulary. |
| 5 | **Sections** | `KnowledgeBase/`, `Data/` are ordinary depth-0 rows | Synthetic sections (Knowledge, Data, Agents, Pipelines, Groups, legacy Skills/Tools) + `Pinned` + a loose-files divider (`FileExplorer.tsx:907-962, 1018-1065`) | **Keep the platform's structure, drop its decoration.** Depth-0 is the signal; the emerald tint is not. |
| 6 | **Tab strip** | `.kbtabs` — underline on active (`inset 0 -2px 0`), close `×` on hover/active only, accent dot when the file has an open change request (proto:712-723, 3816-3825) | `EditorTabs` pills on `bg-sunken`, always-visible close, no CR signal | **Adopt.** |
| 7 | **Page title** | `<h1>` = basename minus extension, with the page's actions beside it (proto:3784-3803) | A 40px chrome strip: 14px filename + 11.5px parent dir + state chips + tab trio + copy-link + Edit (`FileViewer.tsx:618-717`) | **Adopt.** The document names itself; chrome does not. |
| 8 | **Page actions** | Share (bounded, with a chevron menu), Copy page as Markdown, Edit (icons), then `⋯`: File details / Version history / View raw / Copy path (proto:3785-3803) | Copy-link icon + Edit button in the chrome strip; History and Compare as sibling tabs; no Share; no raw view; no copy-as-markdown | **Adopt**, with History/Compare folded behind `⋯` (§3 D4). |
| 9 | **Weight follows stakes** | Share is the one bounded button — it is the one action with a consequence for other people; copy and edit are icons (proto:3781-3783) | Edit is a filled emerald button; Share does not exist on the page at all | **Adopt.** |
| 10 | **The rail** | `<aside>` "About this file": Path (mono), Size, Edited by, Access pill; then "Links out" (proto:3859-3875). Toggled from `⋯`; drives `.wrap.wide` | Does not exist. Owners appear as a full-width banner (`NodeOwnersBanner`); path appears as grey text in the chrome strip | **Adopt**, sourced per §4.3. |
| 11 | **Change-request dock** | Pinned under the tree: collapsible header + amber count + rows `#32 · title · "Ali Raza · 1 file"` (proto:730-750, 3673-3685) | `PullRequestsForMe` at the bottom of the explorer — same job, different voice (`FileExplorer.tsx:1069`) | **Restyle in place.** Do not rebuild. |
| 12 | **Per-file CR signal** | 6px amber `.tdot` on the tree row; accent `.tdirty` on the tab (proto:692, 3577, 3821) | Nothing | **Adopt** — `PullRequestSummary.touchedNodePaths` already carries it (§4.3). |
| 13 | **Open-CR panel** | Amber panel above the body: "Open change request … Review the change" (proto:3805-3809) | Nothing on the page | **Adopt.** |
| 14 | **Right-click menu** | Manage access… / Download / Copy path / New file here (proto:3290-3311) | Superset already: New file, New folder, Unzip, Download, Manage access, Pin, Rename, Delete (`FileExplorer.tsx:171-255`) | **Keep the platform's.** Restyle onto `MenuPanel`/`MenuItem`. |
| 15 | **Share sheet** | `kbAccessModal` — add by email/group, "On this file", collapsible inherited-grant rows per folder (proto:3598+) | `ManageAccessDialog` — 1235 lines, direct-vs-ancestor sources, verb editor, already on the shared `Dialog`/`Menu` (`f905957`) | **Keep the platform's.** Build only the entry points. |
| 15b | **Breadcrumbs** | Deliberately absent in Knowledge — "the tree already shows where this file sits" (proto:3773-3775) | Absent | **Already agrees.** Do not add one. |
| 16 | **Empty state** | — | "Open a file, or ask the process assistant a question." + suggested prompts (`FileViewer.tsx:566-602`) | **Keep**, retypeset onto tokens. |
| 17 | **Banners** | — | Five hand-rolled `bg-amber-50` / `bg-red-50` strips in `FileViewer` (`:734, 752, 777, 791, 827`) | **Retypeset** onto the `Banner` primitive. |
| 18 | **Sidebar toggle glyph** | One `I_PANEL` glyph, one spot in the top bar, both surfaces (proto:3696) | Library uses `SidebarToggle`'s `PanelGlyph`; Knowledge uses lucide `PanelLeft` (`Toolbar.tsx:72`) | **Unify** on `PanelGlyph`. |

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
- Gate: `pnpm ds:check` against `scripts/design-system-baseline.json`
  (`raw-slate-palette: 0`, `raw-hex-in-class: 106`, `off-scale-font-size: 212`,
  `bare-rounded: 203`). **The counts must go DOWN or stay flat. Never up.**
  Knowledge is a large share of the remaining balance — WP2/WP4/WP7 should each retire
  some of it. Re-baseline only with `pnpm ds:baseline` and only downward.

### 2.3 Testing rules

- vitest + happy-dom + `@testing-library/react`. Router via `MemoryRouter`.
- Select **only** by role / accessible name / `aria-label` / `title` / text. The a11y
  contract is frozen: `aria-current` on tree rows and tabs, `aria-expanded` on directory
  rows and disclosure headers, `role="tablist"` on the tab strip, `aria-label` on every
  icon-only control.
- Never assign `window.location.href` in a test.
- Baseline to preserve: **66 frontend test files** at the time of writing, with
  `modules/workspace/__tests__/` holding `FileExplorer`, `EditorTabs`, `FileRoute`,
  `FileViewer`, `KbMarkdownView`, `MarkdownRenderer`, `kb-routes`, `useWorkspaceState`,
  `workspace.api`, `frontmatter`, `CsvRenderer`, `PdfRenderer`, `htmlSandbox`.
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
The prototype's Knowledge is a fixed 212px sidebar plus a centred column. The platform's is
a resizable three-pane workspace whose third pane is contributed by the enterprise registry.
Replacing the pane model would break `registry.panes`, `LayoutController`, the toolbar's
pane toggles and `MobileChatLayout` — for a visual result the user cannot distinguish from
the cheap version. **Decision: keep `ResizableThreePaneLayout`. Introduce the measure as a
centred, max-width column *inside* the viewer pane.** The explorer pane keeps its
`17% / 10% / 35%` sizing and its drag handle, which is a superset of the prototype's
draggable `.side`.

*Consequence:* the prototype's `.app.collapsed .wrap{padding:0 64px}` becomes a property of
the document column responding to its own available width, not to a global "collapsed"
class. Use a container query or a width observer on the column — not a global flag — because
with a chat pane open the viewer can be narrow while the explorer is open, and wide while it
is closed. The rule to implement is *"gutters grow with spare width"*, not *"gutters grow
when the sidebar is hidden"*; the prototype only ever had the second because it only ever
had two panes.

**D2 — The tree keeps every platform capability and loses only decoration.**
Drop: `Folder`/`FolderOpen` icons, the `@iconify` per-extension file glyphs, the emerald
`accent` tint on section roots. Keep: sections, `Pinned`, the loose-files divider,
inline create, rename, drag-to-move, drag-and-drop upload, the pending-upload spinner, the
context menu, auto-expand-to-open-file, and the user-intent-vs-auto-expand resolution at
`FileExplorer.tsx:427, 490-497`. `getFileIcon` and `@iconify/react` each have exactly one
consumer and go dead with the icons — WP2 says how far to take that.

*Rationale, from the prototype (proto:3552-3559):* the folder icon repeated what the caret
said and the file icon repeated what the extension said; both stood where the name should
start. The pending spinner is the one glyph that survives, because it says something no
other part of the row says.

**D3 — `PullRequestsForMe` is the change-request dock. There is no second queue.**
The prototype's `KBCRS` is a mock. The real datum is `PullRequestSummary`, already fetched,
already polled at 60s, already carrying `number`, `title`, `appAuthor.name`,
`touchedNodePaths` and `review`. Restyle its markup into `.crdock`; change nothing about
its fetching, its 60s poll, its vanished-branch pruning, or its `PR_STALE_EVENT` handling.

**D4 — History and Compare move behind `⋯`; Content stops being a tab.**
The prototype's page has one body and an overflow menu. The platform's `activeTab` state
already exists (`FileViewer.tsx:129`) and both panels are real components. Fold the trio:
`Content` is the page; `⋯ → Version history` and `⋯ → Compare versions` set `activeTab`, and
the panel renders in place of the body with a way back. `historyAvailable` still gates both
(`FileViewer.tsx:150`). *Deviation from prototype, flagged:* the prototype has no Compare —
we keep it because it is a real feature with a real entry point today, and silently removing
it would be a regression dressed as a redesign.

**D5 — The rail renders only facts the client can prove.**
`Path` and `Size` are local. `Access` comes from `useFileAccess` — the same hook the
`AccessRestrictedBanner` and `NodeOwnersBanner` already use. `Edited` comes from the file's
git history, which `FileHistoryPanel` already fetches. **`Links out` means the links this
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
  children: ReactNode;
}
```

```ts
// KbPageHeader.tsx — the title block and the page's actions (WP4)
export interface KbPageHeaderProps {
  path: string;                       // workspace-relative
  canWrite: boolean;                  // from useFileAccess; false ⇒ no Edit, no Share edit affordances
  editMode: boolean;
  entering: boolean;                  // "Loading…" while the lock is acquired
  lockedBy: string | null;            // disables Edit and explains why via title
  railOpen: boolean;
  historyAvailable: boolean;
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
  sizeBytes: number | null;           // null ⇒ the row is omitted, never "unknown"
  lastCommit: { author: string; relative: string } | null;
  access: ReturnType<typeof useFileAccess>;
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
export interface OpenChangeRequests {
  /** Workspace-relative paths with at least one open request touching them. */
  paths: ReadonlySet<string>;
  /** The requests touching one path, for the page banner. */
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
| can the caller write | Edit / Share gating | `useFileAccess(path, branch).canWrite` | `FileViewer.tsx:99-100` |
| owners | rail "Access" | `useFileAccess(...).owners` | `FileViewer.tsx:615` |
| lock holder | Edit disabled + reason | `fileLock.externalLock.holderName` | `FileViewer.tsx:704` |
| file bytes | rail "Size" | `openFileContent.length` for text; **null for binary** — omit the row rather than lie | `FileViewer.tsx:566` |
| last edit + author | rail "Edited" | the history the `FileHistoryPanel` already fetches | `modules/git/components/FileHistoryPanel.tsx` |
| links out | rail | parse the rendered content's internal links (same predicate `MarkdownRenderer` uses at `:158`) | `MarkdownRenderer.tsx:158`, `HtmlRenderer.tsx:97` |
| open CRs, per path | tree dot, tab dot, page banner | `PullRequestSummary.touchedNodePaths` | `packages/shared/src/git/pr.types.ts:45` |
| CR number / title / author / file count | dock rows | `number`, `title`, `appAuthor.name`, `touchedNodePaths.length` | same file, `:16-46` |
| open a CR | dock row click | `usePrViewer()` — already wired | `PullRequestsForMe.tsx:7` |

**One honest gap:** the prototype's rail says `Size` for every file. Binary files
(`ImageRenderer`, `PdfRenderer`, `XlsxRenderer`) do not hold their bytes in
`openFileContent`. Rather than add an endpoint for a metadata row, the rail omits `Size`
when it cannot compute it. This is stated as a deviation in WP5's acceptance criteria.

---

## 5. Work packages — build in this order

Each is independently shippable, independently verifiable, and independently revertable.
Do not start a WP before its dependencies have landed.

| WP | What | Depends on | Files touched (approx) | Visible on merge? |
|---|---|---|---|---|
| **WP1** | The measure and the gutters | — | 3 | yes — immediately |
| **WP2** | The tree | — | 2 | yes |
| **WP3** | The tab strip | — | 2 | yes |
| **WP4** | The title block and the page's actions | WP1, WP3 | 4 | yes |
| **WP5** | The rail | WP1, WP4 | 3 | yes |
| **WP6** | The change-request dock and the dots | WP2, WP3 | 5 | yes |
| **WP7** | Chrome parity | WP4 | 4 | yes |

WP1, WP2 and WP3 are disjoint and may run concurrently. WP5 and WP6 may run concurrently
after their dependencies. WP7 lands last because it cleans up what the earlier WPs displace.

---

### WP1 — The measure and the gutters

**Goal.** One column width across Knowledge and Skills; gutters that grow with spare width.

**Build.**
1. `components/KbDocumentShell.tsx` (NEW) — the centred column. Base measure **880px**;
   **980px** with a rail, laid out as `minmax(0, 620px)` + `296px` with a `44px` gap
   (proto:344-345). Vertical rhythm `34px` top / `110px` bottom (proto:137) so the last
   paragraph is not welded to the viewport floor.
2. Mount it in `FileViewer` around the renderer, replacing the bare
   `<div className="flex-1 overflow-hidden p-4">` (`FileViewer.tsx:847`). **The scroll
   container moves with it** — the column scrolls, the pane does not, or the tab strip
   scrolls away with the text.
3. Gutters: `clamp`-style padding that grows with the column's own available width, per
   D1. Floor at the prototype's `40px`, ceiling at its `64px`.
4. `LibraryLayout.tsx:106` — `<main>` gains the same measure (D6).

**Verify.** With the explorer open and closed, and with the chat pane open and closed:
the document column's left edge is the same distance from the pane edge as the Library
page's h1 is from its pane edge, at the same window width. Prose never exceeds ~75
characters. Nothing horizontally scrolls.

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
3. Delete the `accent` prop and its emerald classes; the six section calls at
   `FileExplorer.tsx:1033-1053` drop the flag.
4. Indent → `10 + depth * 13`; the file row's `+18` compensation disappears with the icon,
   and the empty caret slot (`.tw`, 13px) is what keeps names aligned (proto:3571-3572).
5. `ContextMenu` (`:90-256`) → `MenuPanel` / `MenuItem`. Same items, same order, same
   handlers. `Delete` keeps its danger tone via the primitive, not `text-red-600`.
6. `InlineInput` / `RenameInput` → `TextField`, keeping the validation message and the
   `onBlur`-submits-if-valid behavior (and the alert-loop guard at `:711-717`).

**Do not touch.** Drag/drop, upload dispatch, `snapshotEntries`, pin storage, auto-expand,
`findKbRoot`, the sections `useMemo`, `PullRequestsForMe`'s mount point.

**Two things go dead when the icons go, both verified single-consumer:**
- `getFileIcon` (`lib/utils.ts:202`) has exactly one caller — `FileExplorer.tsx:762`.
  Delete it with its last use; a helper nothing calls is a trap for the next reader.
- `@iconify/react` has exactly one import in the entire frontend —
  `FileExplorer.tsx:21`. After WP2 the package is unreferenced. **Dropping it from
  `package.json` is a real bundle win and a one-line change, but it is a dependency
  decision, not a UI one — surface it to Juan rather than taking it inside this WP.**

**Verify.** `FileExplorer.test.tsx` passes with selectors that no longer depend on an icon.
Deep-linking to a nested file still reveals its row. A folder with no children shows no
caret and does not toggle.

---

### WP3 — The tab strip

**Goal.** `EditorTabs` becomes `.kbtabs`.

**Build.**
1. Strip: transparent (not `bg-sunken`), `border-b border-line`, horizontal scroll with the
   scrollbar suppressed (D7's one CSS exception), `gap-0.5`.
2. Tab: `text-detail`, `text-ink-faint`; hover `bg-hover text-ink-muted`; active
   `text-ink font-semibold` + `shadow-[inset_0_-2px_0]` in `ink`. Radius `sm` on the top
   corners only.
3. Close `×`: `opacity-0`, revealed on tab hover, on active, and on
   `focus-visible` — the last one is what keeps it reachable for anyone who never hovers.
4. Leave a slot before the label for WP6's CR dot.

**Do not touch.** Reorder-by-drag, the close→navigate handshake (`EditorTabs.tsx:55-68`),
the unsaved-changes bulk warning, the tab context menu.

**Verify.** `EditorTabs.test.tsx` green. Keyboard: tab to a tab, `focus-visible` shows its
close button, `Enter` activates.

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
     semantics, same disabled reasons.
   - **`⋯`** — `File details` (toggles the rail) · `Version history` · `Compare versions` ·
     `View raw file` · `Copy path`. History and Compare hidden when
     `historyAvailable === false`.
3. Delete the `h-10` strip (`FileViewer.tsx:618-717`) and the `TabButton` component
   (`:884-906`). The unsaved / agent-waiting / reviewing chips move to the title row as
   `Badge`s.
4. `activeTab` stays as state; `history` and `compare` now render in place of the body,
   each with an explicit way back to the document.

**Do not touch.** `handleEnterEditMode` / `handleExitEditMode` / `handleSave` and their
comments — they encode two real races (`:299-324`, `:417-440`). Move the *buttons*.

**Verify.** `FileViewer.test.tsx` green with relocated selectors and every prior assertion
intact. Edit on a locked file is disabled and its `title` names the holder. On a protected
branch there is no Edit and no Share-edit affordance.

---

### WP5 — The rail

**Goal.** "About this file", from facts we can prove (D5).

**Build.**
1. `components/KbFileRail.tsx` (NEW) — `About this file`: `Path` (mono, wrapping),
   `Size` (omitted when unknowable), `Edited` (`{relative} by {firstName}`), `Access`
   (a `Badge` from `useFileAccess`); then `Links out` — buttons that call `openFile`.
2. `hooks/useLinksOut.ts` (NEW) — parse outbound internal links from the active file's
   content using the same predicate `MarkdownRenderer` applies at `:158`. Returns `[]` for
   non-markdown, which renders as no section rather than an empty one.
3. Rail visibility is session state, defaulting **closed**, toggled from `⋯ → File details`.
   Open ⇒ `KbDocumentShell` switches to the wide measure.

**Verify.** The rail never shows a row it cannot fill. Toggling it changes the column width
and nothing else. `NodeOwnersBanner` and the rail do not both claim the owners — pick one
(the rail) and say so in WP7.

---

### WP6 — The change-request dock and the dots

**Goal.** The queue reads like the prototype, and a file that has an open request says so
in all three places it should.

**Build.**
1. `components/KbChangeRequestDock.tsx` (NEW) — the prototype's chrome (proto:730-750):
   a disclosure header `CHANGE REQUESTS` with a caret and an amber count `Badge`, then rows
   `#{number}` + title (ellipsis on the text, never on the flex row — proto:745-747) +
   `{author} · {n} file(s)`. Pinned to the explorer's footer with a `border-t`.
2. Feed it from `PullRequestsForMe`'s existing data (D3). The minimal-risk shape: extract
   that component's fetch/poll/prune into `hooks/useMyPullRequests.ts`, leave its behavior
   byte-identical, and have both the dock and (if it survives anywhere) the old list read
   the hook. If extraction proves invasive, wrap instead — see §2.1 seam 2.
3. `hooks/useOpenChangeRequests.ts` (NEW) — §4.2 contract, derived from
   `touchedNodePaths`.
4. Tree dot: 6px, `bg-wait-dot`, `ml-auto`, `title="Open change request"` (proto:692).
5. Tab dot: 6px, `bg-accent`, before the label (proto:723) — a different colour on purpose:
   in the tree it is news about a file you are not looking at; on a tab it marks the one
   you are.
6. Page banner: `Banner tone="wait"` above the body — "Open change request" + who proposed
   it + a `Review the change` button opening the existing PR viewer (proto:3805-3809).

**Verify.** A file with an open PR shows a dot in the tree, a dot on its tab, and the banner
on its page — all from one fetch. Zero change to poll interval, pruning, or `PR_STALE_EVENT`.

---

### WP7 — Chrome parity

**Goal.** Everything the earlier WPs displaced, retypeset; nothing left saying two things.

**Build.**
1. `Toolbar.tsx:62-74` — the explorer toggle uses `SidebarToggle`'s `PanelGlyph` instead of
   lucide `PanelLeft`, so both surfaces show one glyph in one spot (proto:3696).
2. The five hand-rolled banner strips in `FileViewer` (`:734, 752, 777, 791, 827`) →
   `Banner` with the right tone. The validator `mustFix` list keeps its structure and its
   20-item cap.
3. `NodeOwnersBanner` — decide against the rail (WP5) and remove the duplicate.
4. The empty state (`:566-602`) — `text-head` heading, `text-ui text-ink-muted` body,
   suggested prompts as `Surface` rows. Keep the `seedSuggestedPrompt` registry gate.
5. `FileRoute`'s four full-screen error states (`:287-389`) — `Banner` + tokens; keep every
   sentence, including the dirty-branch explanation.
6. Sweep the ratchet: every `text-[Npx]`, bare `rounded` and raw hex retired from
   `modules/workspace/` in the course of WP1-WP6 gets counted, and the baseline is lowered.

**Verify.** `pnpm ds:check` reports a **decrease**. No `bg-amber-50`, `bg-red-50`,
`text-emerald-*` or `border-red-200` remains under `modules/workspace/`.

---

## 6. File-by-file work plan

### CREATE — all under `packages/core-frontend/src/modules/workspace/`

| File | WP | Contents |
|---|---|---|
| `components/KbDocumentShell.tsx` | 1 | the measure; §4.2 contract |
| `components/KbPageHeader.tsx` | 4 | title + actions; §4.2 contract |
| `components/KbFileRail.tsx` | 5 | About this file + Links out; §4.2 contract |
| `components/KbChangeRequestDock.tsx` | 6 | the dock; prototype chrome over real PR data |
| `hooks/useLinksOut.ts` | 5 | outbound internal links from content |
| `hooks/useOpenChangeRequests.ts` | 6 | path → open requests, from `touchedNodePaths` |
| `hooks/useMyPullRequests.ts` | 6 | extracted from `PullRequestsForMe`, behavior-identical |
| `workspace.css` | 1/3 | **only** scrollbar suppression + any container-query rule; each with a comment saying why it is not a utility |

### MODIFY

| File | WP | Change |
|---|---|---|
| `components/FileExplorer.tsx` | 2, 6 | row chrome; drop folder/file icons + `accent`; caret only when children; indent `10+13d`; `ContextMenu`→`MenuPanel`; inputs→`TextField`; footer slot → dock |
| `components/EditorTabs.tsx` | 3, 6 | `.kbtabs` chrome; hover/focus-only close; CR dot slot |
| `components/FileViewer.tsx` | 1, 4, 5, 6, 7 | mount `KbDocumentShell`; delete the `h-10` strip + `TabButton`; mount `KbPageHeader`, rail, CR banner; banners → `Banner`; empty state retypeset |
| `components/FileRoute.tsx` | 7 | four error states onto `Banner` + tokens |
| `../git/components/PullRequestsForMe.tsx` | 6 | extract the hook; keep every behavior (see §2.1 seam 2) |
| `../access/components/NodeOwnersBanner.tsx` | 7 | removed from the viewer once the rail carries owners |
| `../toolbar/components/Toolbar.tsx` | 7 | one glyph swap |
| `../library/components/LibraryLayout.tsx` | 1 | the shared measure on `<main>` (D6) |
| `scripts/design-system-baseline.json` | 7 | lowered, never raised |

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

All new tests under `packages/core-frontend/src/modules/workspace/components/__tests__/`
(and `hooks/__tests__/` for the two hooks), matching the existing layout.

**New files**

- `KbDocumentShell.test.tsx`
  1. renders children inside a centred column
  2. `rail` prop opens the second track and widens the measure
  3. without `rail`, one track, narrow measure
- `KbPageHeader.test.tsx`
  1. h1 is the basename with a known extension stripped
  2. Share opens the file dialog; the chevron menu offers link + folder
  3. `canWrite: false` renders no Edit
  4. `lockedBy` disables Edit and names the holder in its `title`
  5. `⋯` offers File details / Version history / Compare versions / View raw / Copy path
  6. `historyAvailable: false` hides both history entries
  7. `editMode` swaps Edit for Done
- `KbFileRail.test.tsx`
  1. renders Path, Edited and Access
  2. `sizeBytes: null` omits the Size row entirely (asserted absent, not empty)
  3. empty `linksOut` renders no "Links out" section
  4. clicking a link calls `onOpen` with the target
- `KbChangeRequestDock.test.tsx`
  1. header carries the count; collapsed by default state is honored
  2. a row shows `#n`, the title, and `{author} · {n} files` with correct pluralisation
  3. zero requests renders nothing
- `useOpenChangeRequests.test.ts`
  1. a path in `touchedNodePaths` is in `paths`
  2. `forPath` returns every request touching it
  3. no open PRs → empty set, no throw
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
- `FileRoute.test.tsx` — unchanged assertions, `Banner` selectors.

---

## 8. Edge cases and failure modes

1. **Narrow viewport.** The prototype collapses to a single column under 900px
   (proto:625-633). The platform has `MobileChatLayout` for this. The document column must
   degrade to full width with the prototype's `16px` padding, and the rail must stack below
   the article, never beside it.
2. **Chat pane open on a small window.** The viewer pane can be narrower than the measure.
   The column takes the pane's width minus the floor padding — it never overflows and never
   scrolls horizontally.
3. **Binary files.** No `Size` in the rail (§4.3), no `Copy page as Markdown` (the action
   hides rather than copying nonsense), no `Links out`.
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
9. **PR list unavailable / degraded.** No dock, no dots, no banner — silently. A queue that
   cannot load is not an error state on a page about a document.
10. **A PR touching a path the caller cannot read.** The dot renders only on rows in the
    tree, and the tree only contains what the caller can read — so the dot cannot leak a
    path. The dock row's title comes from GitHub and is already visible to the caller today.
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

- [ ] Knowledge and Skills show the same column width and the same gutters at the same
      window width, with the nav open and with it closed.
- [ ] The Knowledge tree has no folder icons and no per-extension file icons; a childless
      folder has no caret; row typography is identical to `GroupsSidebar`'s rows.
- [ ] Every tree capability survives: create, rename, delete, pin, move by drag, upload by
      drop, unzip, download, manage access, auto-expand to the open file.
- [ ] The tab strip underlines the active tab, reveals its close control on hover and on
      keyboard focus, and marks a file with an open change request.
- [ ] The document page leads with an `<h1>` naming the file, with Share (bounded), Copy
      page, Edit (icons) and `⋯` beside it — and no 40px chrome strip anywhere.
- [ ] `⋯` offers File details, Version history, Compare versions, View raw file, Copy path;
      the two history entries hide when git is not ready.
- [ ] Share opens the existing `ManageAccessDialog`; the chevron additionally offers
      "Copy link to this page" and "Share the whole folder".
- [ ] The rail shows Path, Size (when knowable), Edited, Access, and Links out — and omits
      any row it cannot fill.
- [ ] The change-request dock sits under the tree with a count, and its rows open the PR
      viewer. A touched file shows a dot in the tree, a dot on its tab, and a banner on its
      page.
- [ ] `PullRequestsForMe`'s fetch, 60s poll, branch pruning and `PR_STALE_EVENT` handling
      are behaviorally unchanged.
- [ ] Edit-mode lock semantics are unchanged: acquire-then-reload-then-flip on entry,
      optimistic on exit, with both race guards intact.
- [ ] No route changed, no URL shape changed, no backend file changed, no migration added.
- [ ] `git diff` shows zero changes under `modules/pr/` and `modules/review/`.
- [ ] `pnpm -s typecheck`, `pnpm -s test`, `pnpm -s build` all green; the test count only
      grew.
- [ ] `pnpm ds:check` reports **lower** counts than the baseline this branch started from,
      and the baseline file records the decrease.

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
3. **The dock/`PullRequestsForMe` boundary** (§2.1 seam 2). If extraction is contested,
   wrap instead. Cost: one extra component, zero shared file, same pixels. Decide this
   *before* WP6 starts, not during.
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
