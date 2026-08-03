# MASTER PLAN — Tool page, Group pages, Manage access for groups, Locked groups

Owner: **Juan**. Repo: `/Users/empire23/CodeBases/skill-and-tool-management`, branch `skills-and-tools-ui`.
Executors: autonomous coding agents. **Read this file first, in full, before opening any feature file.**

This directory contains five documents:

| File | What it is |
|---|---|
| `00-MASTER-PLAN.md` | **This file. Binding.** Global constraints, the unified contracts, the reconciliation decisions, and the work-package sequence. Where a feature file disagrees with this file, THIS FILE WINS. |
| `01-tool-page.md` | Tool page with OAuth + Secrets — full design |
| `02-group-pages.md` | Group pages (routed group page + all-groups index) — full design |
| `03-group-access.md` | Manage access for groups — full design |
| `04-locked-groups.md` | Locked groups (discovery + request-access) — full design |

The four feature designs were produced independently and then fact-checked against the
codebase. Every file path, symbol, endpoint and line reference in them was verified to
exist (or is explicitly marked as NEW). Because they were designed independently, they
collide in five places; §3 below resolves every collision. The feature files have NOT
been rewritten — apply the deltas in §3 on top of them.

---

## 1. Division of labor — what you must never touch

**Ali (other engineer, working in parallel) owns:**
- The SKILL page (`/skills-and-tools/skills/:name`) and the skill half of
  `packages/core-frontend/src/modules/library/components/DetailDialog.tsx`
  (`SkillDetailBody`, `SkillCompareHost`, `IntItem`, `ConnectButton`, `OWNER_TAG`,
  `touchesSkill` — everything that is not `ToolDetailBody`).
- The change-request flow: everything under `modules/pr/` and `modules/review/`.
- The Share-panel CONTENTS (the F-lens: Access/People sections inside the panel).

**Hard rule for every work package below:** `git diff` at the end of your work must show
ZERO changes under `packages/core-frontend/src/modules/pr/`,
`packages/core-frontend/src/modules/review/`, and zero changes to the skill half of
`DetailDialog.tsx`. The ONLY permitted DetailDialog change is the removal of its tool
half (WP4, spec in `01-tool-page.md` §5 item 19).

**Seams Ali builds against (frozen by this plan — never rename, never move):**
1. Route contract (§2.1 below).
2. `ToolSharePanel` — path `modules/library/components/tool-page/ToolSharePanel.tsx`,
   props `{ open: boolean; tool: { slug: string; name: string; path: string }; onClose(): void }`,
   dialog title `Share tool`, body placeholder `<div data-testid="tool-share-panel-body" />`.
   Ali replaces the placeholder; you ship the shell.
3. `ProposeSkillPage` — route `/skills-and-tools/propose?group=<name>` is frozen; the
   page internals are a placeholder Ali replaces wholesale. Marked with a `// SEAM:`
   comment in the file.
4. `LibraryRoutes.tsx` carries a `// CONTRACT (Ali):` comment reserving
   `skills/:name` above the `*` fallback.

---

## 2. Unified contracts (binding on all four features)

### 2.1 Route table — the single source of truth

All nested under the existing `/skills-and-tools/*` shell mount
(`CoreAppShell.tsx` `CORE_APPS`; swap the app element to `<LibraryRoutes />`, nothing
else changes in the shell). Inner `<Routes>` use RELATIVE paths.

| Absolute path | Renders | Introduced by |
|---|---|---|
| `/skills-and-tools` (index) | `LibraryPage` (gallery, filter `{kind:'all'}`) | WP3 |
| `/skills-and-tools/owned` | `LibraryPage` filter `{kind:'owned'}` | WP3 |
| `/skills-and-tools/yours` | `LibraryPage` filter `{kind:'ungrouped'}` | WP3 |
| `/skills-and-tools/groups` | `GroupsIndexPage` | WP5 |
| `/skills-and-tools/groups/:group` | `GroupPage` (member OR locked view) | WP5/WP7 |
| `/skills-and-tools/propose` (`?group=`) | `ProposeSkillPage` (Ali's seam) | WP5 |
| `/skills-and-tools/tools/:slug` | `ToolPage` | WP4 |
| `/skills-and-tools/skills/:name` | RESERVED for Ali — do not build | — |
| `/skills-and-tools/*` | `<Navigate to="/skills-and-tools" replace />` | WP3 |
| `/connect`, `/secrets` | FROZEN — exact paths, OAuth return targets | — |
| `/tools` (shell-level, exact) | `ToolsExplorerPage` — UNTOUCHED (different page; no collision with the nested `tools/:slug`) | — |

`LibraryRoutes` lives at **`packages/core-frontend/src/modules/library/routes/LibraryRoutes.tsx`**
(the `01-tool-page.md` path `components/LibraryRoutes.tsx` is superseded). It is the
union of both feature route tables above, created once in WP3 and extended in place.

**URL is the single source of truth for selection.** The `useState<LibraryFilter>` in
`LibraryPage` is deleted in WP3; the sidebar derives selection from the URL and
navigates on click (see `02-group-pages.md` §3). Consequence for `04-locked-groups.md`:
its `{ kind: 'locked-group' }` `LibraryFilter` extension is **DROPPED** (its own risk #3
pre-authorized this). Locked-group selection = navigating to
`/skills-and-tools/groups/:group` where the caller cannot read the group; `GroupPage`
decides member-view vs locked-view (rule in §3.2).

### 2.2 ONE backend groups module — the merged `GET /api/groups`

`02-group-pages.md` §4.2 and `04-locked-groups.md` §4.2 each invented this endpoint
with different DTOs and service names. **Build it ONCE, as specified here.**

Module: `packages/core-backend/src/modules/groups/` — files per `04-locked-groups.md`
§5 (contract / service / access-requests service / routes / index barrel), with the
service named **`GroupIndexService`** and the following MERGED wire type replacing both
`GroupSummary` (02) and `GroupIndexEntry` (04):

```ts
// groups.contract.ts — the unified DTO
export interface GroupPrincipals {
  roles: string[];
  /** email is null on entries the caller cannot read (no email leakage to non-readers). */
  users: { name: string; email: string | null }[];
}
export interface GroupReaders extends GroupPrincipals { restricted: boolean }

export interface GroupSummary {
  name: string;                 // group folder name, e.g. 'GTM'
  folders: string[];            // repo-relative constituent folders, e.g. ['Groups/GTM'] or ['Skills/GTM','Tools/GTM']
  canRead: boolean;             // per-caller; locked === !canRead
  canWrite: boolean;            // per-caller; true ⇒ may manage access (admin-rescue applies to access.md WRITE)
  skillCount: number;           // caller-INDEPENDENT totals
  toolCount: number;
  owners: GroupPrincipals;      // for display: "Run by …" (fallback chain: owners → writers → 'the workspace admins')
  writers: GroupPrincipals;
  readers: GroupReaders | null; // null when !canRead (locked groups never advertise their share list)
  hasRequested: boolean;        // caller has a pending access request; always false when canRead
}
```

Merge decisions (each side's rationale is in its feature file):
- **Counts** come from the global catalogs — `skillService.listSkills(undefined)` +
  the NEW `toolManualService.listAllSummaries()` (added per `04-locked-groups.md` §4.2)
  — bucketed by `groupOfPath`. NOT a separate `walkFiles` scan (02's approach is
  superseded; the catalogs are already cached and invalidated).
- **Folder enumeration**: `readdir` direct subdirectories of `GROUPS_DIR`,
  `LEGACY_SKILLS_DIR`, `LEGACY_TOOLS_DIR`; union by name; per `04` §4.2.
- **canRead / canWrite**: ONE `canReadBatch` + ONE `canWriteBatch` per request over
  probe paths `${folder}/access.md` for every constituent folder; a group's flag = OR
  across its folders. (Probe rationale + verified `readOwnEntries` behavior: `04` §4.2.)
- **Principals**: `eligibleOwners` / `eligibleWriters` / `eligibleReaders` on the
  PRIMARY folder (the `Groups/`-rooted path if present, else first) — per `02` §4.2
  step 3, directory-leaf resolution verified. `readers` = null when `!canRead`.
- **Email stripping**: when `!canRead`, every `users[].email` in `owners`/`writers` is
  null. When `canRead`, full principals (matches the existing `GET /access` disclosure
  posture).
- **`admins` display array (04) is DERIVED client-side**, not a wire field:
  `ownersText` per `02` §2.4 (owners → writers fallback → `the workspace admins`),
  names only. `04`'s copy strings consume that.
- **hasRequested + lazy fulfillment + the three request endpoints + the
  `group_access_requests` table**: verbatim from `04-locked-groups.md` §4.2 (storage,
  idempotency index, route specs, auth gating, admin filtering, no-KB-writes rule).
- **Cache + invalidation**: `TtlCache` 60s on the caller-independent part; extend the
  existing file-change subscriber in `create-core-services.ts` (which already
  invalidates skill/tool caches for `GROUPS_DIR`/legacy roots) with
  `groupIndexService.invalidate()`.
- **Degradation**: scan failure → `{ groups: [] }`; DB failure on the pending lookup →
  `hasRequested: false` everywhere + `console.warn`. Route errors: 401 without email;
  500 `{ error: 'Failed to list groups' }`.

Frontend client: ONE file `modules/library/services/groups.api.ts` exporting the
mirrored `GroupSummary` + `listGroups()` + `requestGroupAccess()` +
`listGroupAccessRequests()` + `dismissGroupAccessRequest()` + `AlreadyReadableError`
(union of `02` §5 and `04` §4.3).

State: `LibraryProvider` (`02` §4.4) is the single host — it also absorbs `04`'s
`useGroupsIndex` (the provider fetches `/api/groups`) while `useGroupAccessRequests`
stays a standalone hook (only the banner needs it).

### 2.3 Corrected fact (binding): admin-rescue does NOT grant read

`02-group-pages.md` §2.1 claims platform Admins see every group under "Groups you're
in" because admin rescue makes folders readable. **That is wrong** — admin-rescue
applies to `access.md` WRITE, not to read (verified; see `04-locked-groups.md` edge
case 12). Correct behavior, everywhere:

- A platform Admin who cannot read a group sees it **locked** (index section
  "Ask to join", locked sidebar row, locked group page) — but with `canWrite: true`,
  so the locked view shows them the `Manage access` self-service button
  (`04` §2.2 item 5).

### 2.4 Design-system + testing rules (apply to every file you create or modify)

- Primitives ONLY from the in-package barrel `packages/core-frontend/src/shared/components`
  (`Button`, `IconButton`, `Surface`, `ListRow`, `Badge`, `Banner`, `TextField`,
  `TextAreaField`, `MenuPanel`/`MenuItem`/`MenuLabel`, `Dialog`, `PageShell`) +
  semantic tokens (`text-ink*`, `bg-canvas/sidebar/surface/sunken/hover/scrim`,
  `border-line*`, `text-micro/label/meta/detail/ui/body/strong/lede/title/head/display*`,
  `rounded-xs/sm/md/lg/xl/2xl`, status colors `ok/wait/danger` + `-soft`).
- **NO raw hex in classes, NO `text-[Npx]`, NO bare `rounded`, NO slate-*** (the slate
  palette is DELETED from the build — slate classes silently no-op). CI gate:
  `pnpm ds:check` must pass with zero baseline increase. Run it before declaring any
  work package done.
- Class composition via `cn()` from `lib/utils` only.
- Tests: vitest + happy-dom + @testing-library/react. Select ONLY by role / accessible
  name / aria-label / title / text (frozen a11y contract). Router via `MemoryRouter`.
  Never assign `window.location.href` in tests (wrap external nav in a spy-able helper).
- Secrets: never fetch, render, log, or echo a stored secret value. Write-only
  `type="password"` inputs posting to existing endpoints. No exceptions.
- Backend: new routes state their auth gating explicitly (all new endpoints here are
  JWT `authMiddleware`, browser-only, never agent/manualAuth). New endpoints write
  Postgres only — the ONLY KB write path in this whole plan remains the existing
  access grant/revoke direct-commit flow, unchanged.
- Verification for every WP: `pnpm -s typecheck` clean, `pnpm -s test` green
  (frontend 46 files/428 tests + backend 100 files/1003 tests baseline — your WP may
  only ADD), `pnpm -s build` clean, `pnpm ds:check` no increase.

### 2.5 Environment facts you must not rediscover wrong

- Groups are FOLDERS (`groupOfPath` from `@bevel-software/platform-shared`), never
  roles/teams. roles.yaml roles: `Admin, Architect, Developer, Agent, GTM Team`.
  Group folders (post-KB-migration): `Everyone, GTM, Engineering, Product`.
- The KB may still be UNMIGRATED (legacy `Skills/` + `Tools/` roots; staging-repo PR #8
  pending). Everything must work against both layouts; `groupOfPath` and the scanners
  already accept both. A group may span `Skills/GTM` + `Tools/GTM` → `folders` has both.
- `OAuthState.r` exists (`secrets-vault.routes.ts:497`, HMAC-signed). `parseAccessFile`
  is at `access-control.service.ts:491` (module-private today), `parseOwnAccessEntries`
  exported at :567. Drizzle schema: `modules/database/core-schema.ts`; migrations via
  `pnpm db:generate` (drizzle-kit) into `packages/core-backend/migrations/`.
- `DEFAULT_WORKSPACE_ID` is exported from `modules/library/services/library.api.ts:19`.

---

## 3. Reconciliation deltas (apply on top of the feature files)

**D1 — `LibraryRoutes` path.** Lives at `modules/library/routes/LibraryRoutes.tsx`.
`01-tool-page.md` §5 item 8's path is superseded; its route entries fold into the
unified table (§2.1). Created in WP3.

**D2 — One groups backend.** Build §2.2, not `02` §4.2's `GroupsService` and not `04`
§4.2's separate DTO. Service name `GroupIndexService`; wire type `GroupSummary` (§2.2).
Everything else in `04` §4.2 (requests table/service/routes, lazy fulfillment,
`listAllSummaries`) stands verbatim.

**D3 — Locked view is ONE component.** `02` §2.3's `GroupLockedView` (frame:
breadcrumb, h1 + `Locked` badge, run-by lede, counts line) and `04` §2.2's
`LockedGroupView` (request button, Requested box, toast, Manage access button) are the
SAME component: **`LockedGroupView`** at
`modules/library/components/LockedGroupView.tsx`, rendering the `02` frame with the
`04` behavior in place of `02`'s neutral `requestSlot` banner (the `requestSlot` prop
indirection is dropped — both halves are Juan's and land together). Props from `04` §5:
`{ group: GroupSummary; onRequested(): void; onUnlocked(): void; onManage(folder: string): void }`.

**D4 — Locked-vs-member decision + sidebar.** `GroupPage` renders the member view when
`canRead === true` OR the caller's catalog has ≥1 item in the group (item-level grants
beat the folder verdict — `02` §8.6 and `04` §5(c) agree); locked view otherwise.
Sidebar: `02` §2.7's shape wins (locked rows after a `h-3.5` gap), plus `04`'s
`aria-label="{name} (locked)"` on each locked row button; locked-row click NAVIGATES to
the group route (no filter state). `GroupsSidebarProps` = `02` §5's interface with
`lockedGroups: string[]`.

**D5 — `filterLibraryItems` untouched by locked groups.** `04` §5's `LibraryFilter`
extension and `filterLibraryItems` change are dropped (D1/D4 make them unnecessary).
`status.ts` is not modified by the locked-groups work.

**D6 — Group access section mounts in `GroupPage` (primary path only).** `03` §3's
fallback mount into `LibraryPage` is dead — WP5 lands `GroupPage` before WP6 starts.
`GroupAccessSection` gets `itemPaths` from `LibraryProvider`'s `LibraryItem[]` (add
`path: string` to `LibraryItem` in WP3 — one field, specified in `03` §3).

**D7 — `02`'s admin-visibility claim corrected** per §2.3 above.

**D8 — `04` M5 (SSE live refresh) is CUT** from the committed scope. It remains in the
feature file as an optional follow-up; do not build it in any WP below.

---

## 4. Work packages — build in this order

Each WP is independently shippable and verifiable; its full spec lives in the named
feature-file sections. Do not start a WP before its dependencies are merged.

| WP | What | Spec | Depends on | Ships dark? |
|---|---|---|---|---|
| **WP1** | Backend: `GET /api/tools/:slug` detail endpoint + `.tool` frontmatter `description` | `01` §4.2, §4.4, §5 items 1,3–6, tests §7 | — | yes |
| **WP2** | Backend: OAuth `returnTo` on tool oauth/start + callback | `01` §4.3, §5 items 2,7, tests §7 | — | yes |
| **WP0** | Backend: unified groups module — `GET /api/groups` (merged DTO §2.2), requests table + 3 request endpoints, `listAllSummaries()`, wiring + invalidation, migration `0002` | `04` §4.2 with §2.2/D2 applied; tests `04` §7 backend (adapt DTO assertions) + `02` §7 backend service cases that still apply (legacy-root merge, sorting, degradation) | — | yes |
| **WP3** | Frontend: routing skeleton — `LibraryRoutes` (§2.1), `LibraryLayout`, `LibraryProvider` (fetches groups; exposes `LibraryItem[]` incl. `path`), URL-driven `GroupsSidebar`, gallery becomes `LibraryPage({filter})` | `02` §3, §4.4, §5 (routes/layout/provider/LibraryPage/GroupsSidebar/CoreAppShell items), tests: `02` §7 `LibraryRoutes.test.tsx` + `GroupsSidebar.test.tsx` (unlocked rows) | WP0 (soft — provider degrades to `[]` against an older backend) | no — gallery must stay pixel-identical |
| **WP4** | Frontend: Tool page — page, connection matrix, OAuth round-trip, share stub, dialog tool-half extraction, `/secrets`+`/connect` deep links | `01` §2, §4.6, §5 items 9–16, 18–25 (item 8 folded into WP3's LibraryRoutes), §6 M3–M5, tests §7 | WP1, WP2, WP3 | no |
| **WP5** | Frontend: Group pages — `GroupPage` (member view), `GroupsIndexPage` + `GroupIndexRow`, `AddToGroupDialog`, `ProposeSkillPage` (Ali seam), sidebar attention counts + "All groups" row | `02` §2 (with D7), §5, §6 M3–M5, tests §7 | WP0, WP3 | no |
| **WP6** | Access section — backend overrides endpoint + `parseAccessFile` export, `ManageAccessDialog` optional `workspaceId` prop, `GroupAccessSection` mounted in GroupPage (D6), `groupFoldersFor` | `03` everything (with D6), tests §7 | WP5 | no |
| **WP7** | Locked groups UI — `LockGlyph`, `LockedGroupView` (D3) wired into `GroupPage` (D4), locked sidebar rows (D4), `AccessRequestsBanner` + `useGroupAccessRequests` + dismiss flow, index "Ask to join" trailing states | `04` §2 (with D3/D4/D5), §5 frontend (minus status.ts + minus its own sidebar/LibraryPage variants — use `02`'s structures), §6 M3–M4, tests §7 frontend (adapt: selection = navigation, not filter) | WP0, WP5 | no |

Parallelism: WP0, WP1, WP2 can run concurrently (disjoint backend modules). WP4 and
WP5 can run concurrently after WP3 (disjoint files EXCEPT `LibraryRoutes.tsx` — WP4
adds one route line; coordinate by landing WP5's route table first or rebasing the
one-line addition). WP6 and WP7 can run concurrently after WP5 (disjoint files except
`GroupPage.tsx` — WP6 appends a section, WP7 adds the locked branch; land WP7 first if
simultaneous, its diff is deeper).

Cross-WP acceptance (run after WP7): the full checklists in each feature file §9, plus:
- A non-reader sees Finance locked in sidebar + index, requests access, sees
  `Requested — …`, survives reload/restart; Olga (folder owner) sees the banner on
  Everything and on the group, grants read via Manage access, requester's next load
  shows the group unlocked and the request row gone (fulfilled, not deleted).
- A platform Admin locked out of a group sees the locked view WITH `Manage access`.
- Tool page OAuth round-trip lands back on `/skills-and-tools/tools/:slug#authorized`
  with the banner; `/connect`-initiated flows still land on `/connect`.
- The whole suite: typecheck, tests, build, `ds:check` — all green, no baseline change.
