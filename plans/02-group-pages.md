# Feature Design: GROUP PAGES (routed group pages + all-groups index)

Owner: Juan. Branch: `skills-and-tools-ui`. Repo: `/Users/empire23/CodeBases/skill-and-tool-management`.

---

## 0. Global copy rule (applies to every screen below)

The prototype's user-facing noun is **"subscription"**; the shipped platform's model and existing UI say **"group"** (folder-derived via `groupOfPath`). All prototype copy is used **verbatim except for a single mechanical substitution**, applied consistently:

| Prototype | Shipped |
|---|---|
| subscription / subscriptions | group / groups |
| "All subscriptions" | "All groups" |
| "Subscriptions you're in" | "Groups you're in" |
| "Ask to subscribe" | "Ask to join" |
| "everyone subscribed" | "everyone in the group" |
| "the {name} subscription at Bevel" (agent prompts) | "the {name} group at Bevel" |

No other copy edits. Every string below is final copy; implement it character-for-character.

---

## 1. Goal + Non-goals

**Goal.** Make a group a *place* with a URL: a routed page per group at `/skills-and-tools/groups/:group` showing that group's skills and tools together, who runs it and who it's shared with (derived from access-rule principals on the group folder), an amber attention state for integrations inside the group that need setup, and the admin/member action pair ("Add skills or tools" for folder-writers, "Propose a skill or tool" for everyone else); plus an all-groups index at `/skills-and-tools/groups` (per `renderSpaces`) listing every group including ones the caller cannot enter. Sidebar selection moves from component state to the URL, so deep links, back button, and Ali's item pages all have stable places to link to. A new read-only backend endpoint `GET /api/groups` supplies group summaries (folders, counts, principals, per-caller can-read/can-write) so locked groups are enumerable the way the prototype demands.

**Non-goals.** No redesign of the skill page, change-request flow, or the skill half of `DetailDialog` (Ali's; this plan only reserves routes and a propose seam). No extraction of `ToolDetailBody` into a routed tool page (separate feature; group pages open the existing `DetailDialog` until item routes exist). No request-access mechanism, no "Requested" state, and no locked-row/locked-splash CTA design (locked-groups feature; this plan renders coordinated placeholder states with explicit slots). No group creation/deletion ("New group", gear menu, "Delete subscription") — creating a folder needs a write endpoint and access bootstrap that don't exist; deferred. No folder-upload dropzone (no upload endpoint in scope). No pending-proposal cards on the group page (CR-driven; Ali's review module owns that surface). No people-count ("{size} people") anywhere — role rosters are admin-gated, so person counts cannot be honestly computed; we show principals instead.

---

## 2. UX spec

### 2.1 Screen: All-groups index — `/skills-and-tools/groups` (port of `renderSpaces`, prototype L2127)

Rendered inside the Library layout (GroupsSidebar on the left, content on the right). Content column, in order:

1. **h1** `All groups` (`text-display font-semibold`).
2. **Lede** (`text-ui text-ink-muted`): `A group carries skills and tools for the people in it.`
3. **Section heading** `Yours` (`text-label uppercase text-ink-faint`, matching existing heading style), then rows:
   - Row **"Owned by me"** — description `The skills you answer for`, meta `{ownedSkillCount} skills`. Click → navigate `/skills-and-tools/owned`. No amber trailing (the prototype's amber here is the CR queue — that badge belongs to Ali's review surface; deliberately omitted).
   - Row **"Yours alone"** (only when `ungroupedCount > 0`) — description `Your sign-ins and the skills no group carries`, meta `{n} skills · {n} tools` (counts of ungrouped skills / ungrouped integrations). Click → `/skills-and-tools/yours`. (Prototype's `MINE()` "{First}'s List" maps to the platform's already-shipped "Yours alone" concept — one name, not two.)
4. **Section heading** `Groups you're in` with a count cap (`{n}` in `text-meta text-ink-faint`, normal case, after the heading): one row per group with `canRead === true` (or with derived items in the caller's catalog — see 8.6), sorted by name:
   - Label: group name; if `canWrite`, a trailing `Badge tone="outline" size="xs"` reading `Owner`.
   - Description: `Run by {ownersText}` (see 2.4 for `ownersText`). If owners resolve empty, description is `{skillCount} skills · {toolCount} tools` alone and the meta slot is left empty.
   - Meta: `{skillCount} skills · {toolCount} tools`.
   - Trailing (inside meta ReactNode): if the group's attention count > 0, `Badge tone="wait" size="xs"` containing the number.
   - Click → `/skills-and-tools/groups/{encodeURIComponent(name)}`.
5. **Section heading** `Ask to join` with count cap (rendered only when at least one locked group exists): one row per group with `canRead === false`:
   - Label: group name. Description: `Run by {ownersText}`. Meta: `{skillCount} skills · {toolCount} tools`.
   - Trailing: an inline lock SVG (`aria-hidden="true"`) inside a span with `title="Locked"`. **Coordination point:** the locked-groups feature replaces this trailing node (e.g. with "Requested") via the `trailing` prop on `GroupIndexRow`; this plan ships only the lock glyph.
   - Click → `/skills-and-tools/groups/{name}` (renders the locked view, 2.3).
6. **Failure state:** if `GET /api/groups` errored, sections 4–5 are replaced by `Banner role="alert" tone="danger"` with the error text and an inline `Try again` button (same pattern as LibraryPage's existing error banner) calling `reloadGroups()`. Section 3 ("Yours") still renders from catalog data.
7. **Loading state:** while groups are loading and no cached data, centered `Loading groups…` in `text-ui text-ink-faint`.

Who sees what: identical for all roles; per-caller `canRead`/`canWrite` from the API decides which section a group lands in and whether the `Owner` badge shows. Admins see every group under "Groups you're in" (admin rescue makes folders writable; readable via canRead resolution).

### 2.2 Screen: Group page, member view — `/skills-and-tools/groups/:group` (port of `renderSpace` member branch, prototype L2512)

Content column, in order:

1. **Breadcrumb row** (`nav aria-label="Breadcrumb"`): quiet link `All groups` (→ `/skills-and-tools/groups`) › current group name (`aria-current="page"`). Right-aligned in the same row, **folder-writers only**: `Button variant="outline" size="sm"` labeled `Share` with a people icon as `leadingIcon` — opens `ManageAccessDialog` targeting the group folder (see Data, 4.3). Hidden when `kbDirName` is null or the group summary is unavailable. No gear menu (non-goal).
2. **h1** `{group name}` (`text-display font-semibold`).
3. **Membership lede** (`text-ui text-ink-muted`, single line, wraps): `Run by {ownersText} · shared with {readersText}` — see 2.4 for exact derivation. Omitted entirely if the group summary failed to load; the `· shared with …` half omitted when readers are withheld or empty.
4. **Attention banner** (only when `attention > 0`): `Banner role="status" tone="wait"`: text `{n} integration{n===1?' needs':'s need'} setup — connect them to unblock this group's skills.` followed by an inline `Button variant="outline" size="tiny"` labeled `Finish setup` → `navigate('/connect')`.
5. **Action button** (exactly one):
   - `canWrite === true` → `Button variant="primary" size="sm"`: `Add skills or tools` → opens **AddToGroupDialog** (2.5).
   - otherwise → `Button variant="outline" size="sm"`: `Propose a skill or tool` → `navigate('/skills-and-tools/propose?group=' + encodeURIComponent(name))` (the seam, §3).
   - If the summary is unavailable (endpoint degraded), default to the Propose button (never claim write access we can't verify).
6. **Skills section**: heading `Skills` (same `text-label uppercase text-ink-faint` style) with count cap `{skillItems.length}`. Grid `grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-2.5` of existing `LibraryCard`s (unchanged component, unchanged `data-testid={'library-card-skill-'+id}`), items = catalog skills whose `group === name`. Click opens the existing `DetailDialog` (state-local, exactly as LibraryPage does today). Empty state (`text-ui text-ink-faint`): `No skills yet. Add one, or ask your agent to write one for {name}.`
7. **Tools section**: heading `Tools` with count cap. Same grid of `LibraryCard kind="integration"` for tools whose `group === name` (status foot shows on non-ok, existing behavior). Empty state: `No tools yet.`
8. Bottom padding `pb-14` matching the gallery.

Who sees what: writers (per folder `canWrite`) get Share + "Add skills or tools"; everyone else who can read gets "Propose a skill or tool". Nothing else differs by role. Pending-proposal cards ("Waiting for your review") are explicitly NOT rendered — that is CR-backed and Ali's; when his review module wants a slot here, it inserts a section between 5 and 6 (documented seam, no code reserved).

### 2.3 Screen: Group page, locked view (port of prototype L2518-2526, minus the request mechanics)

Shown when the summary says `canRead === false` AND the caller's catalog contains zero items in the group (see 8.6). In order:

1. Breadcrumb `All groups › {name}` (no Share).
2. **h1** `{name}` followed inline by `Badge tone="outline" size="sm"` containing the lock SVG (`aria-hidden`) + text `Locked`.
3. Lede 1: `Run by {ownersText}.`
4. Lede 2: `{skillCount} skills · {toolCount} tools — visible to members only.`
5. **CTA slot** (`requestSlot` prop): v1 renders `Banner role="note" tone="neutral"`: `Ask {ownersText} for access.` **Coordination point:** the locked-groups feature replaces this slot's content with its "ask to join" CTA + "Requested" state; this plan owns the frame (items 1–4), not the CTA design.

No skill/tool names, no cards — counts only (prototype: locked groups are enumerable; contents are not).

### 2.4 Membership derivation — the decision

**Membership is displayed as access-rule principals, not as an expanded list of people who can read the folder.** Source: the new `GET /api/groups` endpoint, which resolves per group folder on the default branch:

- **Admins / "Run by"**: `accessControl.eligibleOwners(defaultWsId, groupFolderPath)` — falling back to `eligibleWriters` when owners are empty (owner ⊂ writer; "who runs it" = who can change it). `ownersText` = comma-joined list of owner **user display names** followed by owner **role names**, e.g. `Olga Ivanova, GTM Team`; when the fallback fired and writers are also empty, `ownersText` = `the workspace admins` (admin rescue guarantees this is true).
- **Members / "shared with"**: `accessControl.eligibleReaders(defaultWsId, groupFolderPath)`. `readersText` = `everyone here` when `restricted === false`; otherwise role names + user display names comma-joined, e.g. `GTM Team, Engineering, Ali Baba`. Rendered as plain text in the lede (roles are not visually distinguished from users in v1 — the sentence reads the same way `access.md` does).

**Why principals and not "who can read" head-counts:** (1) Expanding roles to people requires the roster endpoint `GET /api/access/roles`, which is **admin-gated** — non-admins literally cannot enumerate members, so a per-person list would render for admins and vanish for everyone else. (2) The resolver is closeness-first with per-file frontmatter overrides, so "who can read this folder" is not even well-defined at folder granularity — a per-person list would be false precision. (3) Principals are the stored truth (what `access.md` says), cost one `eligibleReaders` call instead of a roster fan-out, and match what `ManageAccessDialog` shows when the writer clicks Share — the two surfaces can never disagree. Consequence (accepted, documented): we never show "{size} people"; the prototype's people counts are dropped everywhere.

Directory-leaf resolution is supported by the access resolver (access-control.service.ts L887-889 explicitly handles folder leaves), so `eligibleOwners/eligibleWriters/eligibleReaders/canRead/canWrite` are called with the folder path (e.g. `Groups/GTM`) directly.

### 2.5 Dialog: AddToGroupDialog (writers only; adapted `addModal`, prototype L2855)

`Dialog` primitive, `size` default, `title`: `Add a skill or tool to {name}`.

Body, in order:
1. Lede paragraph: `Two ways in. Either way it joins {name} — everyone in the group gets it the next time their agent connects.`
2. Option A — a `Surface as="button" interactive padded radius="lg" elevation="none" tone="sunken"` full-width block: primary line `Open {name} in the workspace`, secondary line (`text-detail text-ink-muted`) `A skill is a folder: SKILL.md plus whatever it needs.` Click → `navigate(kbFileUrl(DEFAULT_BRANCH, kbDirName + '/' + summary.paths[0]))` then close. (Replaces the prototype dropzone — no upload endpoint in scope; documented divergence.) Hidden when `kbDirName` is null.
3. Divider line with centered `or` (`text-meta text-ink-faint`).
4. Agent line (`text-ui text-ink-muted`): `Tell your agent what you need — it drafts the skill and adds it to {name}.`
5. Prompt block: `Surface tone="sunken" radius="md" padded` with `font-mono text-detail` text, exact prompt: `Help me build a new skill or tool and add it to the {name} group at Bevel. I run it, so it goes in directly — no review step.`

Footer: `Button variant="quiet"` `Close`; `Button variant="primary"` `Copy prompt` → `navigator.clipboard.writeText(prompt)` + library toast `Prompt copied.`

### 2.6 Page: ProposeSkillPage — `/skills-and-tools/propose?group={name}` (adapted `proposeModal`, prototype L2822; **the seam Ali replaces**)

Rendered inside the Library layout. Content:
1. Breadcrumb: `All groups › {group} › Propose` when `group` param present (links back accordingly); plain h1 otherwise.
2. **h1**: `Propose a skill or tool for {group}` (or `Propose a skill or tool` without the param).
3. Body paragraph: `You build with your agent, not here. Tell it what you need — it drafts the skill or tool and sends it to this group.`
4. Prompt block (same Surface styling as 2.5 item 5), exact prompt: `Help me build a new skill or tool and propose it for the {group} group at Bevel. Ask me what it should do, draft it, then send it to the group for review.` (Without a group param: `Help me build a new skill or tool at Bevel. Ask me what it should do, draft it, then send it for review.`)
5. Footnote (`text-detail text-ink-faint`): `{ownersText} reviews it before it joins {group}.` — omitted when owners unknown or no group param.
6. Buttons: `Button variant="primary"` `Copy prompt` (clipboard + toast `Prompt copied.`); `Button variant="quiet"` `Back to {group}` → the group route (or `Back to the library` → index when no param).

**Seam contract:** the ROUTE (`/skills-and-tools/propose`, query `group`) and the navigation into it are this feature's; everything rendered on the page is a placeholder Ali's change-request flow replaces wholesale (a CR that adds a file into `Groups/{group}/`). This file is the only one in this plan Ali may rewrite.

### 2.7 Sidebar (GroupsSidebar) changes

Keeping the existing layout and row renderer, add:
1. After the `Groups` label: a row **`All groups`** — selected (`aria-current`) when on `/skills-and-tools/groups` or `/skills-and-tools/propose`; count slot empty. Click → `onOpenGroupsIndex()`.
2. Per-group rows: unchanged labels/counts, but when a group's `attention > 0` the count slot renders the attention number in the existing `pending` (amber `bg-wait-soft font-bold text-wait`) tone instead of the grey item count. Zero renders nothing (existing rule: never a grey 0).
3. After readable groups (and the conditional "Yours alone" row), when `lockedGroups.length > 0`: a `div className="h-3.5" aria-hidden="true"` gap (prototype's 14px `.navgap`), then one row per locked group — same button styling, right slot is the lock SVG (`aria-hidden`) inside the fixed count box, and the button carries `title="Locked"`. Click navigates to the group route (locked view). Locked rows never show attention (prototype rule: non-members always 0).

Selection is now driven by the URL (see §3); the sidebar receives the derived filter and calls back with intents, it never owns state.

---

## 3. Routes + navigation contract

**Decision: URL, not filter state.** The prototype treats a space as a *place* (breadcrumb `All subscriptions › GTM`, sidebar as nav). URL routing gives shareable deep links, working back/forward, and — decisively — a stable link target for Ali's item pages and the locked-groups feature. The old `useState<LibraryFilter>` is deleted; the URL is the single source of truth and the sidebar is a pure view of it.

All paths are nested inside the existing `/skills-and-tools/*` app mount (CoreAppShell.tsx L295 — the shell already wildcards; **no shell route changes** beyond swapping the app element). Inner `<Routes>` use **relative** paths.

| Absolute path | Relative path | Renders | Notes |
|---|---|---|---|
| `/skills-and-tools` | `index` | `LibraryPage` (gallery, filter `{kind:'all'}`) | unchanged look |
| `/skills-and-tools/owned` | `owned` | `LibraryPage` filter `{kind:'owned'}` | |
| `/skills-and-tools/yours` | `yours` | `LibraryPage` filter `{kind:'ungrouped'}` ("Yours alone") | |
| `/skills-and-tools/groups` | `groups` | `GroupsIndexPage` | |
| `/skills-and-tools/groups/:group` | `groups/:group` | `GroupPage` | `:group` = `encodeURIComponent(folder name)`; decode with `decodeURIComponent` |
| `/skills-and-tools/propose` | `propose` | `ProposeSkillPage` | query `?group=<name>`; **Ali replaces internals** |
| `/skills-and-tools/*` | `*` | `<Navigate to="/skills-and-tools" replace />` | unknown subpaths fall back to the gallery |

**CONTRACT ALI BUILDS AGAINST (frozen by this document):**
- Skill page: **`/skills-and-tools/skills/:name`** (`:name` = `encodeURIComponent(skill name)`).
- Tool page: **`/skills-and-tools/tools/:slug`** (`:slug` = tool manual slug; NOT the shell's separate exact `/tools` route — no collision because these are nested under `/skills-and-tools`).
- Propose/CR flow: **`/skills-and-tools/propose?group=<name>`**.
Ali inserts his routes into `LibraryRoutes.tsx` ABOVE the `*` fallback. Until they exist, those URLs redirect to the gallery (harmless). When they land, `GroupPage`'s card `onOpen` swaps from `setDetail(...)` to `navigate(...)` — a one-line change flagged with a `// CONTRACT:` comment in the code.

Sidebar↔URL mapping (implemented in `LibraryLayout` via `matchPath`): `/skills-and-tools` → `{kind:'all'}`; `/owned` → `{kind:'owned'}`; `/yours` → `{kind:'ungrouped'}`; `/groups/:group` → `{kind:'group', group}`; `/groups` and `/propose` → no filter (only "All groups" row active). `onSelect(filter)` navigates to the corresponding path; `onOpenGroupsIndex()` navigates to `groups`.

OAuth return targets `/connect` and `/secrets` are untouched.

---

## 4. Data + API design

### 4.1 Existing endpoints used as-is
- `GET /api/skills`, `GET /api/skills/:name`, `GET /api/secrets/tools`, `POST /workspace/:id/access/batch`, `GET /api/workflow/change-requests[/mine]` — all via the existing `useLibraryData()`; hoisted into a provider (4.4), **fetched once** for gallery + group pages + index (the N+1 `getSkill` cost is paid once per Library visit, unchanged).
- `ManageAccessDialog` uses its existing access routes; no changes.

### 4.2 NEW endpoint: `GET /api/groups`

**Auth gating (explicit):** mounted `app.use('/api', core.authMiddleware, createGroupsRoutes(core.groupsService))` in `create-core-server.ts` (with the other JWT browser routes, after L303). Any authenticated user may call it; per-caller fields (`canRead`, `canWrite`) are resolved for `req.userEmail`; `readers` is **withheld (null) when the caller cannot read the group** so locked groups advertise only run-by + counts (prototype parity) and never their full share list. No `:id` param — groups are a default-branch concept, like roles.

**Request:** none (GET, no query).

**Response 200:**
```json
{
  "groups": [
    {
      "name": "GTM",
      "paths": ["Groups/GTM"],
      "canRead": true,
      "canWrite": false,
      "skillCount": 4,
      "toolCount": 2,
      "owners":  { "roles": [],           "users": [{ "name": "Olga Ivanova", "email": "olga@bevel.software" }] },
      "writers": { "roles": ["Admin"],    "users": [] },
      "readers": { "restricted": true, "roles": ["GTM Team"], "users": [] }
    },
    {
      "name": "Finance",
      "paths": ["Groups/Finance"],
      "canRead": false,
      "canWrite": false,
      "skillCount": 3,
      "toolCount": 1,
      "owners":  { "roles": [], "users": [{ "name": "Olga Ivanova", "email": "olga@bevel.software" }] },
      "writers": { "roles": [], "users": [{ "name": "Olga Ivanova", "email": "olga@bevel.software" }] },
      "readers": null
    }
  ]
}
```
Sorted by `name` `localeCompare`. **401** `{ "error": "Not authenticated" }` without JWT (authMiddleware). **500** `{ "error": "Failed to list groups" }` on unexpected failure (frontend shows the danger Banner + Try again).

**Server algorithm** (`GroupsService`, constructed `new GroupsService(workspaceService, accessControl, config.kbDirName)` in `create-core-services.ts`):
1. `ws = await workspaceService.getOrCreateForBranch(DEFAULT_BRANCH)`; base = `join(ws.absolutePath, kbDirName)`.
2. **Scan (cached):** for each root in `[GROUPS_DIR, LEGACY_SKILLS_DIR, LEGACY_TOOLS_DIR]` (from `@bevel-software/platform-shared`), `readdir` its immediate children; every non-dot **directory** is a group; record repo-relative path `${root}/${child}`. Merge same-named groups across roots into one entry with multiple `paths` (exact case-sensitive name match — same rule as `groupOfPath`, which returns the segment verbatim). Per path, `walkFiles` (shared `fs-walk`) counting basenames `SKILL.md` → `skillCount` and suffix `.tool` → `toolCount`, summed across the group's paths. Cache the scan (names/paths/counts only — caller-independent) in a `TtlCache` with TTL 60_000, plus a file-change-notifier subscription in `create-core-services.ts` invalidating on DEFAULT_BRANCH changes under `${kbDirName}/Groups/`, `${kbDirName}/Skills/`, `${kbDirName}/Tools/` (same pattern as the tool-manual subscriber at L294-301; extend that subscriber's body with `groupsService.invalidate()`).
3. **Per request (never cached):** `wsId = workspaceIdForBranch(DEFAULT_BRANCH)`. `canReadBatch(wsId, email, allGroupPaths)` and `canWriteBatch(...)` once each; a group's `canRead`/`canWrite` = OR across its paths. `primary` path = the `Groups/`-rooted path if present, else the first path; `owners = eligibleOwners(wsId, primary)`, `writers = eligibleWriters(wsId, primary)`, `readers = canRead ? eligibleReaders(wsId, primary) : null`. (Directory-leaf resolution is supported — access-control.service.ts L887.)

**Storage:** none. Read-only endpoint; no KB writes, no protected-branch or change-request semantics involved. No secret values anywhere near this feature.

### 4.3 Share (writers) — existing machinery
Group page Share opens `ManageAccessDialog` with a synthesized directory entry:
```ts
const entry: FileTreeEntry = { name: groupName, relativePath: `${kbDirName}/${summary.paths[0]}`, type: 'directory' };
```
The dialog already fully supports directory targets (edits that folder's `access.md`); its grant/revoke writes go through the existing edit-lock direct-commit path — **that is the platform's established semantics for access edits (direct commit even on the protected branch), and this feature does not alter it.** After the dialog closes, call `reloadGroups()` so the membership lede refreshes.

### 4.4 Frontend data plumbing
- `LibraryProvider` (new, `modules/library/state/library-data.tsx`): calls `useLibraryData()` once, derives the (now exported) `LibraryItem[]` exactly as `LibraryPageInner` does today, and additionally fetches `GET /api/groups` (`listGroups()` from the new `groups.api.ts`), exposing:
```ts
export interface LibraryContextValue extends LibraryData {
  items: LibraryItem[];
  groupSummaries: GroupSummary[]; // [] until loaded / on error
  groupsLoading: boolean;
  groupsError: string | null;
  reloadGroups(): void;
}
export function useLibrary(): LibraryContextValue; // throws outside provider
```
- **Attention per group** (frontend-derived, matching the platform's existing semantics): `attentionOf(group) = items.filter(i => i.group === group && i.kind === 'integration' && i.status.state !== 'ok').length`. Deliberate divergence from the prototype's `spaceAttention` (which also counted blocked skills and admin pending proposals): blocked skills would double-count the same broken integration, and pending proposals are CR-driven — the prototype itself insists group amber "is about SETUP, never about change requests". Global `attentionCount` (sidebar footer) is unchanged.

---

## 5. File-by-file work plan

All frontend paths under `packages/core-frontend/src`, backend under `packages/core-backend/src`. Design-system rules apply to every file: barrel-only primitive imports (`../../../shared/components` in-package), `cn()` from `lib/utils`, semantic tokens only, no raw hex / off-scale `text-[Npx]` / bare `rounded` (CI ratchet).

### Backend — CREATE `modules/groups/groups.contract.ts`
```ts
export interface GroupPrincipals { roles: string[]; users: { name: string; email: string }[] }
export interface GroupReaders extends GroupPrincipals { restricted: boolean }
export interface GroupSummary {
  name: string; paths: string[];
  canRead: boolean; canWrite: boolean;
  skillCount: number; toolCount: number;
  owners: GroupPrincipals; writers: GroupPrincipals;
  readers: GroupReaders | null;
}
export interface IGroupsService {
  listForUser(userEmail: string): Promise<GroupSummary[]>;
  invalidate(): void;
}
```

### Backend — CREATE `modules/groups/groups.service.ts`
`export class GroupsService implements IGroupsService`, ctor `(workspaceService: IWorkspaceService, accessControl: IAccessControl, kbDirName: string)`. Private `scan(): Promise<ScannedGroup[]>` (TtlCache 60s; `ScannedGroup = { name; paths; skillCount; toolCount }`) implementing §4.2 step 2; `listForUser` implementing step 3; `invalidate()` clears the cache. Missing roots / missing workspace → empty list (degrade like tool-manuals), errors from access resolution propagate (route returns 500).

### Backend — CREATE `modules/groups/groups.routes.ts`
```ts
export function createGroupsRoutes(groupsService: IGroupsService): express.Router
```
One handler: `router.get('/groups', async (req, res) => ...)` — reads `req.userEmail` (auth middleware augmentation; if absent respond 401 `{ error: 'Not authenticated' }`), responds `{ groups }`, catches → 500 `{ error: 'Failed to list groups' }`.

### Backend — CREATE `modules/groups/index.ts`
Re-export `GroupsService`, `createGroupsRoutes`, types.

### Backend — MODIFY `core/create-core-services.ts`
Construct `groupsService = new GroupsService(workspaceService, accessControl, config.kbDirName)` next to the tool-manual service (≈L189); add `groupsService.invalidate()` inside the existing file-change subscriber (L294-301), extending its path predicate with `${kbDirName}/Skills/`; expose `groupsService` on the returned core object.

### Backend — MODIFY `core/create-core-server.ts`
After L303: `app.use('/api', core.authMiddleware, createGroupsRoutes(core.groupsService));`

### Frontend — CREATE `modules/library/services/groups.api.ts`
```ts
import { authFetch } from '../../../lib/api';
export interface GroupPrincipals { roles: string[]; users: { name: string; email: string }[] }
export interface GroupReaders extends GroupPrincipals { restricted: boolean }
export interface GroupSummary { /* mirror of backend DTO above */ }
export async function listGroups(): Promise<GroupSummary[]>  // GET /api/groups, throws Error('Couldn't load groups.') on !ok
```

### Frontend — CREATE `modules/library/state/library-data.tsx`
`LibraryProvider({ children })` + `useLibrary()` per §4.4. Move the `GalleryItem` derivation out of `LibraryPageInner` into here; export the item type:
```ts
export interface LibraryItem { kind: 'skill' | 'integration'; id: string; name: string; description: string; owned: boolean; status: AttentionStatus; group: string | null }
export function attentionOf(items: LibraryItem[], group: string): number
```

### Frontend — CREATE `modules/library/routes/LibraryRoutes.tsx`
```ts
export function LibraryRoutes(): JSX.Element
```
`<LibraryToastProvider><LibraryProvider><Routes>` with a layout route `<Route element={<LibraryLayout/>}>` containing the table from §3 (index/owned/yours/groups/groups/:group/propose/*). Contains the `// CONTRACT (Ali):` comment block reserving `skills/:name` and `tools/:slug` above the `*` fallback.

### Frontend — CREATE `modules/library/components/LibraryLayout.tsx`
```ts
export function LibraryLayout(): JSX.Element
```
Owns the flex shell (`flex h-full min-h-0 bg-canvas text-ink`), derives the filter from `useLocation()` via `matchPath` (§3 mapping), computes sidebar inputs from `useLibrary()` (`groupCounts`, `ownedCount`, `ungroupedCount`, `attentionCount` — logic moved verbatim from `LibraryPageInner` — plus per-group `attention` and `lockedGroups = groupSummaries.filter(g => !g.canRead && no derived items).map(g => g.name)`), renders `<GroupsSidebar .../>` + `<main className="min-w-0 flex-1 overflow-y-auto px-8 py-6"><Outlet/></main>`.

### Frontend — MODIFY `modules/library/components/LibraryPage.tsx`
Becomes the gallery **content** only:
```ts
export function LibraryPage({ filter }: { filter: LibraryFilter }): JSX.Element
```
- DELETE: `LibraryToastProvider` wrapper, `GalleryItem` interface, `useState<LibraryFilter>`, `GroupsSidebar` rendering, the outer flex div, the local `useLibraryData()` call.
- KEEP (moved onto context): heading (`headingFor`), search `TextField` (component state, unchanged), error Banner/loading/empty states, card grid, `openDetail` + `DetailDialog` rendering (props fed from `useLibrary()`).
- `headingFor` unchanged except it now also receives group filters only via props.

### Frontend — CREATE `modules/library/components/GroupPage.tsx`
```ts
export function GroupPage(): JSX.Element   // reads useParams().group
```
Implements §2.2/§2.3 state machine: loading → locked (delegating to `GroupLockedView`) → not-found (`This group doesn't exist yet.` + link `All groups`) → member view. Local state: `detail: DetailTarget | null`, `addOpen: boolean`, `shareOpen: boolean`. Renders `DetailDialog`, `AddToGroupDialog`, `ManageAccessDialog` (with the §4.3 entry) as needed. Uses `useWorkspace().kbDirName`, `useLibrary()`, `useNavigate()`.

### Frontend — CREATE `modules/library/components/GroupLockedView.tsx`
```ts
export interface GroupLockedViewProps { summary: GroupSummary; requestSlot?: ReactNode }
export function GroupLockedView(props: GroupLockedViewProps): JSX.Element
```
§2.3 exactly; default `requestSlot` = the neutral "Ask {ownersText} for access." Banner.

### Frontend — CREATE `modules/library/components/GroupsIndexPage.tsx` + `GroupIndexRow.tsx`
```ts
export function GroupsIndexPage(): JSX.Element
export interface GroupIndexRowProps {
  label: string; badge?: ReactNode; description?: string; meta?: string;
  trailing?: ReactNode; onOpen(): void;
}
export function GroupIndexRow(props: GroupIndexRowProps): JSX.Element
```
`GroupIndexRow` = `ListRow as="button" density="row"` with `label` (+ badge inline), `description`, `meta` (counts text + trailing node). §2.1 assembly lives in `GroupsIndexPage`.

### Frontend — CREATE `modules/library/components/AddToGroupDialog.tsx`
```ts
export interface AddToGroupDialogProps { name: string; primaryPath: string; onClose(): void }
export function AddToGroupDialog(props: AddToGroupDialogProps): JSX.Element
```
§2.5. Uses `useWorkspace().kbDirName`, `kbFileUrl`, `useLibraryToast`, `useNavigate`.

### Frontend — CREATE `modules/library/components/ProposeSkillPage.tsx`
```ts
export function ProposeSkillPage(): JSX.Element  // reads useSearchParams().get('group')
```
§2.6. Header comment: `// SEAM: route + ?group are frozen contract; page internals are Ali's to replace with the change-request flow.`

### Frontend — MODIFY `modules/library/components/GroupsSidebar.tsx`
New props (breaking, single consumer):
```ts
export interface GroupsSidebarProps {
  filter: LibraryFilter | null;
  onSelect(filter: LibraryFilter): void;
  groups: { group: string; count: number; attention: number }[];
  lockedGroups: string[];
  groupsIndexActive: boolean;
  onOpenGroupsIndex(): void;
  ownedCount: number;
  ungroupedCount: number;
  attentionCount: number;
  onFinishSetup(): void;
}
```
Row renderer unchanged; additions per §2.7 (All groups row; attention-tinted counts; navgap + locked rows with `title="Locked"` and lock SVG). Locked-row click calls `onSelect({ kind: 'group', group })` (layout navigates; the page decides locked vs member rendering).

### Frontend — MODIFY `core/CoreAppShell.tsx`
`CORE_APPS` skills-tools entry: `element: <LibraryRoutes />` (import swap only).

### Frontend — MODIFY `core/__tests__/ShellRoutes.test.tsx`
Update the `/skills-and-tools` assertion to whatever stable text the gallery renders (`Library` h1 persists) — keep the test green with the new element.

### DELETE
Nothing deleted; `DetailDialog`, `LibraryCard`, `useLibraryData`, `status.ts` untouched (Ali's skill half untouched).

---

## 6. Milestones (dependency order; each shippable + verifiable)

**M1 — Backend `GET /api/groups`.** Files: `modules/groups/*` + `create-core-services.ts` + `create-core-server.ts` + backend tests. Verify: `curl -H "Authorization: Bearer $JWT" localhost:PORT/api/groups` returns the DTO against a KB with `Groups/` and one with legacy `Skills//Tools/`; 401 without token. Ships alone (no consumer yet).

**M2 — Routing skeleton.** Files: `LibraryRoutes.tsx`, `LibraryLayout.tsx`, `state/library-data.tsx`, `services/groups.api.ts`, modified `LibraryPage.tsx`, `GroupsSidebar.tsx` (URL-driven filter only; locked/attention props may land stubbed as `[]`/`0`), `CoreAppShell.tsx`, ShellRoutes test. Verify: gallery pixel-identical at `/skills-and-tools`; sidebar clicks change the URL; deep links `/skills-and-tools/owned`, `/skills-and-tools/groups/GTM` (renders group page shell or redirect if M3 not in), unknown paths redirect; browser back works.

**M3 — Group page.** Files: `GroupPage.tsx`, `GroupLockedView.tsx`, `AddToGroupDialog.tsx`, `ProposeSkillPage.tsx` + tests. Verify: member view sections/copy per §2.2; writer sees Share + Add, non-writer sees Propose → lands on `/skills-and-tools/propose?group=…`; attention banner appears iff a group tool is non-ok and Finish setup lands on `/connect`; locked group renders §2.3; Share opens ManageAccessDialog on the folder and the lede refreshes after close.

**M4 — All-groups index.** Files: `GroupsIndexPage.tsx`, `GroupIndexRow.tsx` + tests. Verify: three sections with exact copy; locked rows in "Ask to join" with lock glyph; rows navigate; error Banner + Try again on endpoint failure.

**M5 — Sidebar completion.** Wire real `lockedGroups` + per-group `attention` into `GroupsSidebar`; "All groups" row active-state on `/groups` + `/propose`. Verify: amber counts match group pages; locked groups listed after the gap; `pnpm ds:check` still passes (run in every milestone; it's the gate).

---

## 7. Test plan (vitest + happy-dom; select by role/aria-label/title/text only)

**Backend `packages/core-backend/src/modules/groups/__tests__/groups.service.test.ts`** (temp-dir workspace fixture + stub IAccessControl, mirroring tool-manuals service tests):
- `derives groups from Groups/ children`
- `merges legacy Skills/ and Tools/ roots into one group with both paths`
- `counts SKILL.md files as skills and .tool files as tools across merged roots`
- `canRead/canWrite OR across a group's multiple root paths`
- `withholds readers (null) when the caller cannot read`
- `returns owners and counts for unreadable groups`
- `sorts by name and skips non-directory children and dot-dirs`
- `invalidate() drops the scan cache` (mutate fs between calls)
- `missing Groups/Skills/Tools roots yield an empty list, not an error`

**Backend `.../groups/__tests__/groups.routes.test.ts`** (supertest-style, stub service):
- `401 when req.userEmail is absent`
- `200 { groups } passthrough shape`
- `500 { error: 'Failed to list groups' } when the service throws`

**Frontend `modules/library/__tests__/LibraryRoutes.test.tsx`** (mock `authFetch`/fetch for the five data endpoints + `/api/groups`; render `<MemoryRouter initialEntries=[...]>` around the app element):
- `renders the gallery at /skills-and-tools with heading Library`
- `sidebar group click navigates to /skills-and-tools/groups/<name>`
- `/skills-and-tools/owned selects Owned by me (heading + aria-current on the sidebar row)`
- `/skills-and-tools/groups renders the All groups heading`
- `deep link /skills-and-tools/groups/GTM renders that group's cards only`
- `unknown subpath /skills-and-tools/nope redirects to the gallery`

**Frontend `modules/library/__tests__/GroupPage.test.tsx`:**
- `shows only the group's skills and tools (data-testid library-card-*)`
- `writer sees Share and "Add skills or tools"; dialog opens with title "Add a skill or tool to GTM"`
- `non-writer sees "Propose a skill or tool" and clicking navigates to /skills-and-tools/propose?group=GTM`
- `attention banner text and Finish setup → /connect`
- `membership lede renders "Run by … · shared with …" from the summary`
- `readers restricted=false renders "shared with everyone here"`
- `locked group renders Locked badge, counts lede, and no cards`
- `unknown group renders "This group doesn't exist yet." with an All groups link`
- `summary endpoint failure: member view still renders items, no lede, Propose button shown`
- `Share opens ManageAccessDialog against the group folder (dialog visible by role)`

**Frontend `modules/library/__tests__/GroupsIndexPage.test.tsx`:**
- `renders Yours / Groups you're in / Ask to join sections with exact ledes`
- `"Yours alone" row hidden when nothing is ungrouped`
- `readable row: Owner badge when canWrite, meta "{n} skills · {n} tools", wait badge when attention>0`
- `locked row shows title="Locked" and navigates to the group page`
- `groups endpoint error renders alert Banner with Try again calling reloadGroups`

**Frontend `modules/library/__tests__/GroupsSidebar.test.tsx`:**
- `All groups row present and aria-current on the index`
- `group row shows amber attention count when attention>0, grey count otherwise, nothing at 0`
- `locked groups render after the gap with title="Locked"`
- `onSelect fires with the right LibraryFilter per row`

**Frontend `modules/library/__tests__/AddToGroupDialog.test.tsx`:**
- `Copy prompt writes the exact addPrompt text to the clipboard and toasts`
- `"Open GTM in the workspace" navigates to the KB folder URL and closes`
- `workspace button hidden when kbDirName is null`

**Frontend `modules/library/__tests__/ProposeSkillPage.test.tsx`:**
- `renders group-specific title, prompt, and reviewer footnote from owners`
- `renders the generic variant without ?group`

**Updated:** `core/__tests__/ShellRoutes.test.tsx` (`/skills-and-tools` renders the Library heading via LibraryRoutes). Existing `DetailDialog.test.tsx`, `status.test.ts`, `diff.test.ts` must stay green untouched.

---

## 8. Edge cases + failure modes

1. **Loading:** catalog loading → gallery/group pages show `Loading the library…`; groups endpoint loading → index shows `Loading groups…`; group page renders member view from catalog items even while summaries load (lede/buttons appear when they arrive; Propose is the default button until `canWrite` is known).
2. **`GET /api/groups` fails / 500:** index shows the danger Banner + Try again ("Yours" section still renders); group page degrades to catalog-derived view — no membership lede, no Share, Propose button, breadcrumb intact; sidebar shows no locked groups. Never blank-screens.
3. **403/401:** authMiddleware handles auth; an expired session surfaces through the existing `authFetch` behavior identically to the rest of the Library.
4. **Empty group (folder exists, no items):** member view renders both empty states (`No skills yet. …` / `No tools yet.`); counts read `0 skills · 0 tools` on the index. Writers can still Add/Share.
5. **Unmigrated KB (legacy `Skills/`/`Tools/` roots, pre KB PR #8):** backend scans all three roots and merges by name, `groupOfPath` already accepts legacy roots frontend-side, so pages/counts/routes work identically; a group spanning `Skills/GTM` + `Tools/GTM` gets `paths` with both, canRead/canWrite OR'd across them, principals from the first path (documented approximation — if the two folders' access rules diverge, "run by" reflects the skills folder; acceptable because PR #8 collapses them). AddToGroupDialog opens `paths[0]`.
6. **Locked-but-partially-visible group:** closeness-first resolution means per-file frontmatter can grant a caller one skill inside a folder they can't read. Rule: the group page shows the **member view** whenever the caller's catalog has ≥1 item in the group, regardless of folder `canRead` (never hide items the platform already returned); the index lists such a group under "Groups you're in". Locked view requires `canRead === false` AND zero derived items.
7. **Tool with no group (`Tools/slack.tool`, `groupOfPath → null`):** lives only in "Yours alone" (`/skills-and-tools/yours`) and the "Yours" index row — untouched by this feature; never appears on any group page.
8. **Group named with URL-hostile characters** (`Sales & Ops`): always `encodeURIComponent` on link creation, `decodeURIComponent(params.group)` on read; tests cover a spaced name. A group literally named `groups`, `owned`, `yours`, `propose`, `skills`, or `tools` is safe — group pages live under the `/groups/` segment, so no collision.
9. **Group in URL doesn't exist:** not-found state (§5 GroupPage), never a redirect loop.
10. **Owners empty everywhere:** `ownersText` falls back through writers to `the workspace admins`; propose footnote omitted only if even that is unwanted — it isn't: footnote renders with the fallback text.
11. **Attention semantics:** only integrations count (state !== 'ok'); skills with `warn` never add to group badges (divergence from prototype documented in §4.4); locked groups always show no attention.
12. **Stale scan cache:** ≤60s staleness after out-of-band KB edits (same envelope as tool manuals); notifier invalidation covers workflow-driven default-branch changes.
13. **Clipboard API unavailable (non-secure context):** `navigator.clipboard?.writeText` guarded; on failure toast `Couldn't copy — select the prompt text instead.`
14. **`kbDirName` null (workspace context not ready):** Share button and the workspace-open block in AddToGroupDialog hidden; everything else unaffected.

---

## 9. Acceptance criteria checklist

- [ ] `/skills-and-tools`, `/owned`, `/yours`, `/groups`, `/groups/:group`, `/propose` all render inside the Library layout; unknown subpaths redirect to the gallery; browser back/forward work.
- [ ] Sidebar selection is URL-derived (no filter useState anywhere); every sidebar row navigates; `aria-current` tracks the URL.
- [ ] `GET /api/groups` exists, JWT-gated, returns the §4.2 DTO, withholds `readers` for unreadable groups, merges legacy roots, 401/500 as specified; zero KB writes.
- [ ] Group page shows the group's skills AND tools via `LibraryCard` (existing testids), with exact empty-state copy.
- [ ] Membership lede sourced from folder access principals (`eligibleOwners`→`eligibleWriters` fallback + `eligibleReaders`), rendered as `Run by … · shared with …`; `everyone here` when unrestricted; no people counts anywhere.
- [ ] Attention: amber Banner on the group page and amber sidebar badge both equal the count of that group's integrations with `status.state !== 'ok'`; `Finish setup` → `/connect`.
- [ ] Writers (folder `canWrite`) see `Share` (→ ManageAccessDialog on the group folder) and `Add skills or tools` (dialog with exact §2.5 copy incl. the agent prompt); non-writers see `Propose a skill or tool` → `/skills-and-tools/propose?group=…` with exact §2.6 copy.
- [ ] Index page: `All groups` h1, lede, `Yours` / `Groups you're in` / `Ask to join` sections with exact copy, counts meta, Owner badge, lock glyph rows that navigate to the locked view; locked-row trailing is a slot for the locked-groups feature.
- [ ] Locked group page renders name, `Locked` badge, `Run by …`, `{n} skills · {n} tools — visible to members only.`, and the neutral ask-for-access Banner in a replaceable `requestSlot`.
- [ ] Route contract comment for Ali (`skills/:name`, `tools/:slug`, `propose`) present in `LibraryRoutes.tsx`; no file in `modules/pr/`, `modules/review/`, or the skill half of `DetailDialog.tsx` touched.
- [ ] All new components use barrel primitives + semantic tokens; `pnpm ds:check` passes with no baseline increase; no secret values fetched or rendered.
- [ ] All §7 test files exist and pass; `ShellRoutes.test.tsx` updated and green; existing library tests untouched and green.

---

## 10. Open risks + fallbacks

1. **Folder-path resolution in `eligible*`/`canReadBatch`.** The resolver documents directory-leaf support (access-control.service.ts L887-889), but if `canReadBatch` turns out to treat a bare folder path as a file (wrong scope chain), fallback: backend resolves `canRead` per group as "caller can read ≥1 scanned item file in the group" (reuse the already-walked file list with one `canReadBatch` over item paths) and keeps `eligible*` on the folder path via the same code path the access routes' `resolvedView` uses (`kind='folder'`). Service-internal change only; DTO unchanged.
2. **Perf of `eligible*` fan-out.** 3 resolver calls × N groups per request; N is single-digit today. If it grows, add a per-user 30s TtlCache keyed by email inside `GroupsService`. DTO unchanged.
3. **KB PR #8 timing.** If it merges mid-implementation, nothing breaks (both layouts scanned); if a group temporarily exists under `Groups/X` AND legacy roots with conflicting access, "run by" prefers `Groups/X` (primary-path rule) — accept until migration completes.
4. **Ali's item routes slip.** Group pages keep opening `DetailDialog` indefinitely — fully functional; the swap to links is one flagged line per card kind.
5. **Locked-groups feature reshapes locked UX.** Contact surface is deliberately tiny: `GroupIndexRow.trailing` and `GroupLockedView.requestSlot`. If they need summary data this endpoint doesn't return (e.g. request state), that's additive to the DTO (new optional field), never a reshape.
6. **`GroupsSidebarProps` breakage.** Single consumer (`LibraryLayout`) after this refactor; if another consumer appears mid-flight, make the new props optional with defaults (`lockedGroups = []`, `groupsIndexActive = false`, `onOpenGroupsIndex = noop`, per-group `attention = 0`).
7. **Copy-substitution dispute (group vs subscription).** All strings are centralized in the components listed above with no shared copy module; a global rename is a grep for the section-2 strings. If product later re-adopts "subscription", only copy changes — routes stay `/groups/` (URLs are not user-facing copy).

