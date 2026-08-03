# Feature Design: LOCKED GROUPS (discovery + request-access) — Juan's plan, Feature "Locked Groups"

Repo: `/Users/empire23/CodeBases/skill-and-tool-management`, branch `skills-and-tools-ui`.
All paths below are absolute or repo-relative; all code identifiers are exact.

---

## 1. Goal + Non-goals

**Goal.** A group whose contents the caller cannot read (the prototype's Finance space) must still *exist* for that caller: it appears as a locked row in the Library sidebar (lock glyph, no counts, no attention badge), and selecting it shows a locked-group page — group name, a "Locked" badge, who runs it, total skill/tool counts ("visible to members only"), and a request-access button with an idempotent "Requested" state. The request is persisted server-side (Postgres, via the existing drizzle `Database`), and the group's admins — resolved as anyone who can write the group folder's `access.md`, which includes platform Admins via the existing admin-rescue — see pending requests as a banner on the group's Library view (and aggregated on "Everything"), from which they open the existing `ManageAccessDialog` on the group folder to grant read, or dismiss the request. A granted request auto-fulfills lazily (the server observes the requester can now read and retires the row); the requester's next Library load shows the group unlocked with its contents. No secret values are touched anywhere in this feature.

**Non-goals.** No membership model or people-count for groups (groups are folders, not teams; "N people" from the prototype is not honestly computable and is dropped). No new frontend routes — locked-group selection is sidebar state exactly like every other Library filter today; if the routed group-index feature later mounts `/skills-and-tools/groups/:group`, `LockedGroupView` is mount-agnostic and moves for free. No admin notification badge, inbox page, or email/Slack notification — the banner on the Library is the whole admin surface (SSE live-refresh is an explicitly optional milestone). No changes to Ali's skill page, change-request flow, `modules/pr/`, `modules/review/`, or the skill half of `DetailDialog`. No auto-granting: granting access is always the existing `/api/workspace/:id/access/grant` flow with its existing direct-commit semantics. No agent-surface changes: `GET /api/agent/all-tools`, `list_local_tools`, etc. keep their fail-closed filtering and never learn about locked groups. No hiding of group existence: names/counts/admin display names of locked groups are deliberately public (prototype: "Locked spaces are fully enumerable"); a truly-secret-group mode is out of scope and listed as a risk.

---

## 2. UX spec

Vocabulary note: the platform's user-facing word is **group** (folders under `Groups/`, legacy `Skills/`/`Tools/`). The prototype says "subscription"; we keep its sentence *structure and copy verbatim where it transfers*, substituting nothing where the sentence doesn't mention the noun (the key strings — the button, the counts line, the requested box, the toast — never say "subscription", so they port verbatim).

### 2.1 Library sidebar (`GroupsSidebar`) — all authenticated users

Current order (unchanged): brand block → "Owned by me" → "Everything" → `GROUPS` label → unlocked group rows → "Yours alone" (conditional).

**New, appended after "Yours alone":** if there is ≥1 locked group:
- a 14px spacer (`<div className="h-3.5" aria-hidden="true" />`) — the prototype's `.navgap`;
- one row per locked group, alphabetical (`localeCompare`), same row chrome as other rows:
  - label: group name (truncated),
  - right slot (in the same fixed count box position): a lock glyph, `text-ink-faint`, **never** a count and **never** an amber badge (prototype: non-members always show attention 0),
  - `aria-label="{name} (locked)"` on the button (the a11y handle tests select on),
  - `aria-current` set when selected.
- Locked rows show a lock glyph even when the caller has already requested access (the prototype sidebar has no "Requested" state; that state lives on the page and, in the prototype, on the index rows — we have no index rows).

Unlocked group rows additionally gain zero-item server-known groups: a group folder that exists but whose visible item count for the caller is 0 still renders (with no count badge — the existing "no grey 0" rule). This falls out of merging the server group index into the sidebar (see §5, `LibraryPage`).

The sidebar's amber `attentionCount` footer is untouched — locked groups never contribute.

### 2.2 Locked-group page (`LockedGroupView`) — shown when a locked row is selected

Rendered in the Library's `<main>` column in place of the search field + card grid (search is hidden; there is nothing to search). Section order top to bottom:

1. `<h1 className="text-display font-semibold">{name}</h1>` with, inline after it, `<Badge tone="outline" size="sm">` containing the lock glyph + the text `Locked` (prototype: `.pill.team` with LOCK_SVG + " Locked").
2. Lede line (`text-lede text-ink-muted`): `Run by {admins}.` where `{admins}` = display names joined with `", "` and `" and "` before the last (e.g. "Olga Ivanova", "Olga Ivanova and Juan Viera", "A, B and C"). If `admins` is empty: `Run by your workspace admins.`
   *Deviation from prototype flagged: prototype says "{size} people · run by {admins}"; the people-count is dropped because group membership is not a real concept in the folder/roles model (read may arrive via roles or `everyone`), so no honest number exists.*
3. Second line (`text-ui text-ink-muted`), copy **verbatim** from the prototype with real counts: `{skillCount} skills · {toolCount} tools — visible to members only.` (pluralize: `1 skill`, `1 tool`; the separator ` · ` and the em-dash clause exactly as written).
4. One of:
   - **Not yet requested:** `<Button variant="primary">Subscribe to its skills and tools</Button>` (copy verbatim, prototype L2523). While the POST is in flight the button is disabled.
   - **Requested** (`hasRequested` from the server, or optimistic after a successful POST): a `Surface` (tone `sunken`, radius `lg`, padded) containing `text-body`: `Requested — {admins} decides who joins.` (verbatim structure, prototype L2525; empty-admins fallback: `Requested — your workspace admins decide who joins.`).
5. **Admin escape hatch** (net-new, no prototype equivalent): if the server says `canManage: true` (caller can write the folder's `access.md` — includes platform Admins locked out of *reading*), render a `<Button variant="quiet">Manage access</Button>` beneath, opening `ManageAccessDialog` on the group folder.

On clicking the request button: POST fires; on 200 the view flips to the Requested box and a Library toast shows, copy **verbatim** (prototype L3025): `Asked {firstNames} — you get its skills and tools if they let you in.` where `{firstNames}` = first whitespace-token of each admin display name, joined as above; empty-admins fallback: `Asked the admins — you get its skills and tools if they let you in.` On 409 `kind:'already-readable'` (access was granted between page load and click): silently refresh the whole library — the group unlocks. On any other failure: toast `Couldn't send that — try again.` and the button re-enables.

### 2.3 Admin request banner (`AccessRequestsBanner`) — group admins only

Server-filtered: `GET /api/groups/access-requests` only returns requests for groups the *caller* administers, so the component renders for exactly the right people with no client-side role check.

Placement: at the top of the Library `<main>` content, above the card grid:
- on the **Everything** view (`filter.kind === 'all'`): one banner per group that has pending requests (discovery guarantee — admins land here);
- on a **group** view (`filter.kind === 'group'`): the banner for that group only.

Banner: `<Banner tone="wait" role="status">`. Copy (net-new; the prototype has **no** admin side — confirmed absent):
- one requester: `{requesterName} asked to join {group} — grant read access to let them in.`
- multiple: `{n} people asked to join {group}: {names}.` (names joined as in §2.2).

Actions inside the banner:
- `Manage access` (`Button variant="outline" size="sm"`) — one button when the group has a single constituent folder; when an unmigrated KB gives the group two folders, two buttons labeled `Manage access (Skills)` and `Manage access (Tools)` targeting `Skills/{group}` and `Tools/{group}` respectively. Opens the existing `ManageAccessDialog` (directory target — it already supports folders and edits that folder's `access.md`). Granting `read` there uses the existing grant route and its existing **direct-commit-to-default-branch** semantics; this feature adds no new KB write path.
- per requester: `Dismiss` (`Button variant="quiet" size="sm"`, `aria-label="Dismiss request from {requesterName}"`). Calls the dismiss endpoint; on success the row disappears; on 403/404 toast `Couldn't dismiss that — try again.`

When the admin closes `ManageAccessDialog`, the Library refetches the group index and the request list — a granted requester's row vanishes via lazy fulfillment (no explicit "approve" click needed; granting *is* approving).

### 2.4 Who sees what, by role (roles.yaml: Admin, Architect, Developer, Agent, GTM Team)

| Surface | Reader of the group | Non-reader | Non-reader who can write the folder's access.md (always includes platform **Admin** via admin-rescue) |
|---|---|---|---|
| Sidebar | normal group row + counts | locked row, lock glyph | locked row, lock glyph |
| Group page | card grid | LockedGroupView + request button / Requested box | LockedGroupView + request button + `Manage access` |
| Request banner | only if they administer the group | never | yes (server-filtered) |
| Agent surfaces | unchanged | unchanged (contents invisible, no existence leak added) | unchanged |

**Agent** role users interacting through agent endpoints see nothing new; the locked-group surface is browser/JWT-only.

### 2.5 What metadata a non-reader sees, and why it's safe (the discovery decision)

Exposed for a locked group: `name`, `folders` (repo-relative constituent folder paths), `skillCount`, `toolCount`, `admins` (display names ONLY — role display names and user *names*), `hasRequested`, `canManage`.

- **Name/folders**: org structure, already the product decision in the prototype ("Locked spaces are fully enumerable"); folder paths add nothing beyond the name + which root (Groups/Skills/Tools) it lives under.
- **Counts**: numbers only, verbatim prototype behavior ("N skills · N tools — visible to members only"). Reveals volume, never names/descriptions/paths of items.
- **Admin display names**: required for "Run by …" and "… decides who joins", and so the requester knows who to ping. **No emails** — parity with the `/access/suggest` email-harvesting guard (which withholds people under 2 query chars); role display names are already public via suggest. A user grant whose display name is empty is *omitted*, never replaced by its email or local-part.
- **Never exposed to non-readers**: item names/descriptions/paths, member/reader rosters, reader counts, admin emails. Requester **emails** are exposed only on the admin-gated request list (`GET /api/groups/access-requests`), to people who can already see emails through the admin roster and who need the email to grant access.

---

## 3. Routes + navigation contract

**This feature adds ZERO frontend routes.** Locked-group selection is `LibraryPage` component state (an extension of `LibraryFilter`), consistent with the Library's current architecture where group nav is state, not URL.

Contract notes for the other three features / Ali:
- The `/skills-and-tools/*` mount already exists (`CoreAppShell.tsx:295`); item pages under `/skills-and-tools/...` are owned by the other features. This feature does not claim any sub-path.
- `LockedGroupView` takes a `GroupIndexEntry` prop and has no routing assumptions; if/when a sibling feature adds `/skills-and-tools/groups/:group`, mount `LockedGroupView` there for locked groups without change.
- `/connect` and `/secrets` are untouched (OAuth return targets — frozen).
- The retired `/tools` explorer page and `/roles-and-members` are untouched.

**New backend HTTP surface (the contract other features may read but not redefine):** four endpoints under `/api/groups*`, specified in §4.

---

## 4. Data + API design

### 4.1 Existing endpoints used as-is (no changes)

- `GET /api/skills` / `GET /api/skills/:name` — unchanged; still canRead-filtered (locked contents stay hidden from the gallery).
- `GET /api/tools`, `GET /api/secrets/tools` — unchanged.
- `GET /api/workspace/:id/access?path&kind`, `POST /api/workspace/:id/access/grant`, `.../revoke`, `.../suggest` — unchanged; `ManageAccessDialog` drives them. Granting read on a group folder commits directly to the default branch via the existing edit-lock queue (existing, documented behavior — **no new protected-branch write path is introduced by this feature**; all new endpoints below write only to Postgres, never to the KB).
- `GET /api/admin/access` — unchanged (not needed; admin-ness for this feature is per-folder `canWrite`, resolved server-side).

### 4.2 NEW backend module: `packages/core-backend/src/modules/groups/`

#### Storage — one new table (drizzle, `core-schema.ts`)

```ts
export const groupAccessRequests = pgTable('group_access_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  groupName: text('group_name').notNull(),
  requesterEmail: text('requester_email').notNull(), // lowercased at insert
  requesterName: text('requester_name').notNull(),   // denormalized, like file_locks.holder_name
  status: text('status').notNull().default('pending'), // 'pending' | 'fulfilled' | 'dismissed'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at'),
  resolvedByEmail: text('resolved_by_email'), // dismisser's email; 'system:fulfilled' marker not used — fulfillment leaves it null
}, (t) => ({
  // Idempotency: at most ONE pending request per (group, requester).
  pendingUnq: uniqueIndex('group_access_requests_pending_unq')
    .on(t.groupName, t.requesterEmail).where(sql`${t.status} = 'pending'`),
  byGroup: index('group_access_requests_by_group').on(t.groupName, t.status),
  byRequester: index('group_access_requests_by_requester').on(t.requesterEmail, t.status),
  statusCheck: check('group_access_requests_status',
    sql`${t.status} IN ('pending','fulfilled','dismissed')`),
}));
```

Migration: run `pnpm db:generate` in `packages/core-backend` → commits `migrations/0002_group_access_requests.sql` + updated `migrations/meta/` (journal entry idx 2). It is `0002`, not `0001`: `dev` shipped `0001_user_password_hash` under this branch, and the released migration keeps its number. Rows are never deleted (audit trail, mirroring the revoked-not-deleted pattern).

**Why DB rows and not the event bus or a KB file:** the `WorkflowEventBus` is in-memory/SSE only (no persistence — a restart loses everything), and a KB file write would either hit the protected default branch (needing the change-request machinery for a non-content concern) or live on a branch nobody reads. `createAccessRoutes` already receives `db: Database`, so a table is the smallest mechanism the repo already has that survives restarts and supports idempotency.

#### Types (`groups.contract.ts`)

```ts
export interface GroupIndexEntry {
  name: string;            // group folder name, e.g. 'Finance'
  folders: string[];       // repo-relative constituent folders, e.g. ['Groups/Finance'] or ['Skills/GTM','Tools/GTM']
  locked: boolean;         // per-caller: caller can read NONE of the constituent folders
  skillCount: number;      // TOTAL (caller-independent) skills under the group
  toolCount: number;       // TOTAL tools under the group
  admins: string[];        // display names only (role names + user names); NEVER emails; may be []
  hasRequested: boolean;   // caller has a pending access request for this group
  canManage: boolean;      // caller canWrite '<folder>/access.md' for ≥1 constituent folder
}
export interface GroupAccessRequestEntry {
  id: string;
  group: string;
  requesterName: string;
  requesterEmail: string;  // admin-gated surface only
  createdAt: string;       // ISO
}
export interface IGroupIndexService {
  /** Caller-independent catalog part (folders, counts, admins) — cached 60s. */
  catalog(): Promise<Omit<GroupIndexEntry,'locked'|'hasRequested'|'canManage'>[]>;
  invalidate(): void;
}
```

#### `GroupIndexService` (`groups.service.ts`)

`constructor(workspaceService: WorkspaceService, accessControl: IAccessControl, skillService: ISkillService, toolManualService: IToolManualService, kbDirName: string)`.

`catalog()` (TtlCache, `CACHE_TTL_MS = 60_000`, same pattern as skills/tools):
1. `wsId = workspaceIdForBranch(DEFAULT_BRANCH)`; `getOrCreateForBranch(DEFAULT_BRANCH)` — any failure degrades to `[]` (matching both scanners).
2. Enumerate group folders: `readdir` with `withFileTypes` on `<workspacePath>/<kbDirName>/<root>` for each of `GROUPS_DIR`, `LEGACY_SKILLS_DIR`, `LEGACY_TOOLS_DIR` (from `@bevel-software/platform-shared`); keep direct subdirectories, skip dot-entries; missing root → skip. Union by name → `folders` list per group (a group may span `Skills/GTM` + `Tools/GTM` pre-migration; direct files like `Tools/slack.tool` are NOT groups — matches `groupOfPath`'s ≥3-segment rule).
3. Counts: `skillService.listSkills(undefined)` (the documented global, unfiltered set) bucketed by `groupOfPath(s.path)`; tools via **new** `toolManualService.listAllSummaries()` bucketed by `groupOfPath(t.path)`. Ungrouped items (null) count nowhere.
4. Admins per group: union over constituent folders of `accessControl.eligibleOwners(wsId, `${folder}/access.md`)` → `[...roles, ...users.map(u => u.name).filter(Boolean)]`, deduped, sorted. (Probing `<folder>/access.md` resolves the folder chain root→…→folder; `readOwnEntries` returns null for `access.md` paths by design, so no per-file frontmatter interferes — verified in `access-control.service.ts:1610-1622`.)
5. Sort entries by name (`localeCompare`).

**Lockedness (per request, not cached):** in the route, one `accessControl.canReadBatch(wsId, email, allProbePaths)` where probe = `${folder}/access.md` for every constituent folder of every group. `locked = folders.every(f => verdict.get(f + '/access.md') !== true)` — fail-closed like every other surface. Rationale: `canRead('<folder>/access.md')` is exactly folder-chain readability (root `access.md` → … → the folder's own `access.md`), the same chain that gates every real child; a nonexistent `access.md` reads as null own-entries and the chain decides, so the probe works whether or not the file exists.
**canManage (per request):** `accessControl.canWriteBatch(wsId, email, sameProbePaths)`; true for any folder → `canManage` (admin-rescue on `access.md` write makes platform Admins always true — intended).

Precedence note: `locked` is the server's verdict on the *folder*. A caller with an item-level grant inside an otherwise-locked group will see that item in the gallery AND the group row unlocked client-side (see §5 LibraryPage merge rule: client-visible items win over the server's locked flag).

`invalidate()` wired into the existing Subscriber A in `create-core-services.ts` (default-branch changes under `Groups/`, `Skills/`, `Tools/` — extend the existing `touched()` block; note `LEGACY_SKILLS_DIR` must now also invalidate the group index even though it already invalidates `skillService`).

#### `AccessRequestsService` (`access-requests.service.ts`)

`constructor(db: Database)`. Methods (drizzle over `groupAccessRequests`):
- `create(group: string, requesterEmail: string, requesterName: string): Promise<void>` — `insert().values({...email.toLowerCase()...}).onConflictDoNothing({ target: [groupName, requesterEmail], targetWhere: status='pending' })` (idempotent under the partial unique index; on races the DB constraint settles it).
- `pendingByRequester(email): Promise<{ id, groupName }[]>`
- `pendingAll(): Promise<{ id, groupName, requesterEmail, requesterName, createdAt }[]>` (status='pending', order by createdAt asc)
- `getPending(id): Promise<Row | null>`
- `markFulfilled(ids: string[]): Promise<void>` — status='fulfilled', `resolvedAt = now()`.
- `dismiss(id: string, byEmail: string): Promise<boolean>` — `UPDATE … SET status='dismissed', resolvedAt=now(), resolvedByEmail=… WHERE id=… AND status='pending'`; returns whether a row changed (atomic, no read-modify-write race).

#### Routes (`groups.routes.ts`) — `createGroupsRoutes(groupIndex: GroupIndexService, requests: AccessRequestsService, accessControl: IAccessControl): express.Router`

Mounted in `create-core-server.ts` right after the skills routes (~line 299): `app.use('/api', core.authMiddleware, createGroupsRoutes(core.groupIndexService, core.groupAccessRequests, accessControl));` — **auth gating: JWT `authMiddleware` on every endpoint; every handler additionally 401s `{ error: 'Unauthenticated' }` when `req.userEmail` is missing (the skills-routes pattern). No endpoint is agent/manualAuth-exposed. No endpoint writes to the KB.**

1. **`GET /api/groups`** → `200 { groups: GroupIndexEntry[] }`
   - Build from `catalog()` + per-caller `canReadBatch`/`canWriteBatch` probes + `pendingByRequester(email)`.
   - **Lazy fulfillment (requester side):** for each of the caller's pending requests whose group is now NOT locked for them, `markFulfilled` and report `hasRequested: false`.
   - `hasRequested` is `true` only while `locked && pending`.
   - Failure of the underlying scan degrades to `{ groups: [] }` (matches catalog philosophy: the Library must never break because groups can't be read); DB failure on the pending lookup also degrades (`hasRequested: false` everywhere) with a `console.warn`.

2. **`POST /api/groups/:name/access-requests`** (no body) →
   - group not in catalog → `404 { error: 'Unknown group', kind: 'unknown-group' }` (`:name` matched case-sensitively against catalog names; Express auto-decodes).
   - caller already reads any constituent folder → `409 { error: 'You can already read this group', kind: 'already-readable' }`.
   - else `requests.create(name, req.userEmail, requesterName)` where `requesterName` = the auth user's display name (`authService.getUserById(req.userId)?.name ?? req.userEmail` — pass `authService` in if needed; simplest: routes take `resolveUserName: (req) => string` bound in create-core-server from `core.authService`). Repeat POST → same `200 { ok: true, hasRequested: true }` (idempotent).

3. **`GET /api/groups/access-requests`** → `200 { requests: GroupAccessRequestEntry[] }`
   - `pendingAll()`; drop rows whose group no longer exists in the catalog (folder deleted — rows stay pending in DB but hidden; see edge cases).
   - **Lazy fulfillment (admin side):** batch `canReadBatch` per distinct (requester, group-probe) pair; any requester who can now read → `markFulfilled`, excluded.
   - **Admin filter:** include a row only if the CALLER has `canWrite` on `${folder}/access.md` for ≥1 constituent folder of the row's group (one `canWriteBatch` over the distinct probe set). Non-admins therefore receive `[]` — never a 403, so the frontend can poll it unconditionally.
   - Sorted `createdAt` asc. This is the ONLY surface exposing requester emails, and it is per-group-admin gated by construction.

4. **`POST /api/groups/access-requests/:id/dismiss`** (no body) →
   - row missing or not pending → `404 { error: 'Not found' }`.
   - caller fails the same per-group admin `canWrite` gate → `403 { error: 'Not allowed' }`.
   - else `dismiss(id, callerEmail)` → `200 { ok: true }` (if the atomic update reports no change — raced with another dismiss/fulfill — return `404`).

#### Change to `tool-manuals` (additive, 6 lines)

`packages/core-backend/src/modules/tool-manuals/tool-manuals.contract.ts`: add to `IToolManualService`:
```ts
/** Global, UNFILTERED summaries (all callers' view combined) — for caller-independent counting. Never expose item names from this to non-readers. */
listAllSummaries(): Promise<ToolManualSummary[]>;
```
`tool-manuals.service.ts`: implement by mapping `await this.scan()` through the same summary projection `listAccessible` uses (extract the existing mapper into a private `toSummary(d)` if it's inline). Mirrors `skillService.listSkills(undefined)`'s documented global mode.

#### Wiring (`create-core-services.ts` / `create-core-server.ts` / `core-ports.ts` if services are typed there)

- `create-core-services.ts`: construct `const groupIndexService = new GroupIndexService(workspaceService, accessControl, skillService, toolManualService, config.kbDirName);` and `const groupAccessRequests = new AccessRequestsService(db);` near the skill/tool services (~L190); add `groupIndexService.invalidate()` to Subscriber A: `if (touched(GROUPS_DIR) || touched(LEGACY_SKILLS_DIR) || touched(LEGACY_TOOLS_DIR)) groupIndexService.invalidate();`. Also: access grants/revokes commit through the same pipeline, so a grant on `Groups/Finance/access.md` lands as a default-branch file change and drops the cache — lockedness updates within one round-trip. Export both on the returned `core` object.
- `create-core-server.ts` (~L299): mount as in §4.2 routes.
- `modules/groups/index.ts`: re-export `GroupIndexService`, `AccessRequestsService`, `createGroupsRoutes`, and the contract types.

### 4.3 Frontend API client (`packages/core-frontend/src/modules/library/services/groups.api.ts`)

```ts
import { authFetch } from '../../../lib/api';           // same helper library.api.ts uses
export interface GroupIndexEntry { /* mirror of §4.2, verbatim */ }
export interface GroupAccessRequestEntry { /* mirror */ }
export class AlreadyReadableError extends Error {}       // thrown on 409 kind:'already-readable'
export async function listGroups(): Promise<GroupIndexEntry[]>                 // GET /api/groups
export async function requestGroupAccess(name: string): Promise<void>          // POST /api/groups/:name/access-requests (encodeURIComponent(name)); 409 already-readable → throw AlreadyReadableError
export async function listGroupAccessRequests(): Promise<GroupAccessRequestEntry[]> // GET /api/groups/access-requests
export async function dismissGroupAccessRequest(id: string): Promise<void>     // POST /api/groups/access-requests/:id/dismiss
```

---

## 5. File-by-file work plan

### Backend — CREATE
| File | Contents |
|---|---|
| `packages/core-backend/src/modules/groups/groups.contract.ts` | `GroupIndexEntry`, `GroupAccessRequestEntry`, `IGroupIndexService` (§4.2) |
| `packages/core-backend/src/modules/groups/groups.service.ts` | `export class GroupIndexService implements IGroupIndexService` — constructor + `catalog()` + `invalidate()` per §4.2; `CACHE_TTL_MS = 60_000`; uses `TtlCache` from `../../shared/ttl-cache.js`, `GROUPS_DIR/LEGACY_SKILLS_DIR/LEGACY_TOOLS_DIR/groupOfPath/DEFAULT_BRANCH` from `@bevel-software/platform-shared`, `workspaceIdForBranch` from `../workspace/workspace.service.js` |
| `packages/core-backend/src/modules/groups/access-requests.service.ts` | `export class AccessRequestsService` with the six methods in §4.2, drizzle over `groupAccessRequests` |
| `packages/core-backend/src/modules/groups/groups.routes.ts` | `export function createGroupsRoutes(groupIndex, requests, accessControl, resolveUserName): express.Router` — the four handlers per §4.2 (imports `'../auth/auth.middleware.js'` for the Request augmentation, like skills.routes.ts) |
| `packages/core-backend/src/modules/groups/index.ts` | barrel re-exports |
| `packages/core-backend/migrations/0002_group_access_requests.sql` (+ `meta/` updates) | generated by `pnpm db:generate` after the schema edit |

### Backend — MODIFY
| File | Change |
|---|---|
| `packages/core-backend/src/modules/database/core-schema.ts` | append `groupAccessRequests` table (§4.2 verbatim) |
| `packages/core-backend/src/modules/tool-manuals/tool-manuals.contract.ts` | add `listAllSummaries()` to `IToolManualService` |
| `packages/core-backend/src/modules/tool-manuals/tool-manuals.service.ts` | implement `listAllSummaries()` (reuse/extract the summary mapper) |
| `packages/core-backend/src/core/create-core-services.ts` | construct the two services; extend Subscriber A invalidation; expose on `core` |
| `packages/core-backend/src/core/create-core-server.ts` | mount `createGroupsRoutes` behind `core.authMiddleware` (~L299), binding `resolveUserName = (req) => core.authService.getUserById(req.userId!)?.name ?? req.userEmail!` |

### Frontend — CREATE
| File | Contents |
|---|---|
| `packages/core-frontend/src/modules/library/services/groups.api.ts` | client per §4.3 |
| `packages/core-frontend/src/modules/library/hooks/useGroupsIndex.ts` | `export interface GroupsIndexState { loading: boolean; groups: GroupIndexEntry[]; reload(): void }`; `export function useGroupsIndex(): GroupsIndexState` — fetch on mount + revision counter; **errors degrade silently to `groups: []`** (matches the Library's phase-2 degradation asymmetry) |
| `packages/core-frontend/src/modules/library/hooks/useGroupAccessRequests.ts` | `export interface GroupAccessRequestsState { requests: GroupAccessRequestEntry[]; dismiss(id: string): Promise<void>; reload(): void }`; fetch on mount; silent-degrade to `[]`; `dismiss` calls API then reloads, rethrows on failure for the caller's toast |
| `packages/core-frontend/src/modules/library/components/LockGlyph.tsx` | `export function LockGlyph({ className }: { className?: string })` — inline SVG, `aria-hidden="true"`, `viewBox="0 0 24 24"`, `fill="none" stroke="currentColor" strokeWidth={2}`, `<rect x=5 y=11 width=14 height=9 rx=2/>` + `<path d="M8 11V8a4 4 0 0 1 8 0v3"/>`; default sizing left to `className` (tokens only — no hex, no off-scale text, no bare `rounded`) |
| `packages/core-frontend/src/modules/library/components/LockedGroupView.tsx` | `export interface LockedGroupViewProps { group: GroupIndexEntry; onRequested(): void; onUnlocked(): void; onManage(folder: string): void; }`; `export function LockedGroupView(props)` — §2.2 exactly; internal `requesting` state; uses `useLibraryToast()`; helpers `joinNames(names: string[]): string` and `firstNames(names: string[]): string[]` exported from this file for tests; calls `requestGroupAccess`, on success toast + `onRequested()`, on `AlreadyReadableError` → `onUnlocked()` |
| `packages/core-frontend/src/modules/library/components/AccessRequestsBanner.tsx` | `export interface AccessRequestsBannerProps { group: string; folders: string[]; requests: GroupAccessRequestEntry[]; onManage(folder: string): void; onDismiss(id: string): void; }`; renders §2.3; `Banner` requires explicit `role="status"`; renders `null` when `requests.length === 0` |

### Frontend — MODIFY
| File | Change |
|---|---|
| `packages/core-frontend/src/modules/library/utils/status.ts` | extend `LibraryFilter` union with `\| { kind: 'locked-group'; group: string }`; `filterLibraryItems` returns `[]` for that kind (a locked group has no visible items by definition) |
| `packages/core-frontend/src/modules/library/components/GroupsSidebar.tsx` | add prop `lockedGroups: { name: string }[]` to `GroupsSidebarProps`; render §2.1 (spacer + locked rows: `aria-label="{name} (locked)"`, `aria-current`, right-slot `<LockGlyph className="size-3 shrink-0 text-ink-faint"/>` inside the fixed count box, `onSelect({ kind: 'locked-group', group: name })`) |
| `packages/core-frontend/src/modules/library/components/LibraryPage.tsx` | (a) `headingFor` gains `case 'locked-group': return filter.group;` (b) call `useGroupsIndex()` + `useGroupAccessRequests()` in `LibraryPageInner`; (c) sidebar merge rule: `visibleGroupNames = new Set(groupCounts(items).map(g=>g.group))`; `lockedGroups = index.groups.filter(g => g.locked && !visibleGroupNames.has(g.name))` (client-visible items beat a stale server `locked` flag); `groups` prop = union of `groupCounts(items)` and server *unlocked* groups not already present (`count: 0`), sorted by name; (d) when `filter.kind === 'locked-group'`: hide the search `TextField` and the grid, render `<LockedGroupView group={entry} onRequested={index.reload} onUnlocked={() => { setFilter({kind:'all'}); index.reload(); data.reload(); }} onManage={setManageFolder}/>`; if the entry has vanished from the index (unlock landed), fall back to rendering the normal group view; (e) render `AccessRequestsBanner`(s) above the grid per §2.3 placement, `onManage={setManageFolder}`, `onDismiss` → `requestsState.dismiss` with failure toast; (f) new state `manageFolder: string \| null` → when set, render `<ManageAccessDialog entry={{ name: manageFolder.split('/').pop()!, relativePath: \`${kbDirName}/${manageFolder}\`, type: 'directory' }} onClose={() => { setManageFolder(null); index.reload(); requestsState.reload(); }}/>` (import from `'../../access/components/ManageAccessDialog'`; `kbDirName` from `useWorkspace()` — guard: `Manage access` affordances render only when `kbDirName` is non-null, same guard `ToolDetailBody` uses) |

### DELETE — nothing.
Design-system compliance: every new component uses only barrel primitives (`Button`, `Badge`, `Banner`, `Surface`, `TextField` already present) + semantic token classes (`text-ink-*`, `bg-*`, `text-display/lede/ui/meta/label/body`, `rounded-sm/md/lg`, `h-3.5`, `size-3`); zero raw hex, zero `text-[Npx]`, zero bare `rounded`, zero slate — the ratchet counts must not move.

---

## 6. Milestones (dependency order; each independently shippable + verifiable)

**M1 — Backend discovery (no DB).** `listAllSummaries()`, `groups` module with `GroupIndexService` + `GET /api/groups` (with `locked`, `counts`, `admins`, `folders`, `canManage`; `hasRequested` hardcoded `false`), wiring + Subscriber A invalidation, tests. *Verify:* `curl -H "Authorization: Bearer $JWT" localhost:PORT/api/groups` shows the Finance-style group as `locked: true` for a non-reader and `locked: false` for a reader; response contains no `@` characters in `admins`.

**M2 — Request persistence + endpoints.** Schema + migration `0002`, `AccessRequestsService`, `POST /api/groups/:name/access-requests`, `GET /api/groups/access-requests`, `POST .../:id/dismiss`, real `hasRequested` + lazy fulfillment in `GET /api/groups`. *Verify:* POST twice → one pending row; GET as group admin lists it; grant read via the existing access UI → GET no longer lists it and the row is `fulfilled`; dismiss path flips to `dismissed`.

**M3 — Requester UI.** `groups.api.ts`, `useGroupsIndex`, `LibraryFilter` extension, `LockGlyph`, sidebar locked rows, `LockedGroupView` + toast + requested state, LibraryPage wiring (d,a,b,c of the modify table). *Verify:* as a non-reader, Finance appears after the gap with a lock; selecting it shows the verbatim copy; clicking the button flips to "Requested — …" and survives reload.

**M4 — Admin UI.** `useGroupAccessRequests`, `AccessRequestsBanner`, dismiss flow, `ManageAccessDialog` wiring (`manageFolder` state), locked-view `Manage access` button. *Verify:* as Olga (folder owner) the banner appears on Everything and on Finance; "Manage access" opens the existing dialog on `Groups/Finance`; granting read makes the requester's row disappear on next load; Dismiss removes it immediately.

**M5 (OPTIONAL — cut first).** Live admin refresh: add `GroupAccessRequestedEvent { kind: 'group-access-requested'; group: string }` (GLOBAL scope, **no requester identity in the payload** — it fans out to every session) to `packages/shared/src/workflow/events.ts`'s `WorkflowEventPayload` union; emit from the POST handler (pass `eventBus` into `createGroupsRoutes`); `useGroupAccessRequests` subscribes via the existing frontend event-bus hook (must render below `EventBusProvider` — LibraryPage already does) and calls `reload()` on the event. Ships nothing user-visible beyond freshness; polling-free core does not depend on it.

---

## 7. Test plan (vitest; frontend under happy-dom, select on role/aria-label/title only)

**Backend**
- `packages/core-backend/src/modules/groups/__tests__/group-index.service.test.ts` (temp-dir workspace stub, pattern of `skills.service.test.ts`):
  1. `enumerates Groups/ subfolders as groups`
  2. `unions legacy Skills/ and Tools/ subfolders into one group (unmigrated KB)`
  3. `ignores loose files under group roots (Tools/slack.tool is not a group)`
  4. `counts skills and tools from the global catalogs by groupOfPath`
  5. `admins come from eligibleOwners on <folder>/access.md and contain no emails` (JSON.stringify of result contains no `'@'`)
  6. `degrades to [] when the workspace cannot be created`
  7. `caches for the TTL and rescans after invalidate()` (spy on readdir)
- `packages/core-backend/src/modules/groups/__tests__/access-requests.service.test.ts` (in-memory fake `Database`, pattern of `session-ontology.service.test.ts`):
  1. `create is idempotent per (group, requester) while pending`
  2. `create lowercases the requester email`
  3. `dismiss flips only pending rows and stamps resolvedByEmail/resolvedAt; returns false otherwise`
  4. `markFulfilled retires rows and pendingAll excludes them`
- `packages/core-backend/src/modules/groups/__tests__/groups.routes.test.ts` (real express server + native fetch, pattern of `roles.routes.test.ts`; stub `IAccessControl`, real `GroupIndexService` over a temp KB, fake db):
  1. `GET /api/groups → 401 without userEmail`
  2. `GET /api/groups marks a group locked when every folder probe is false, unlocked when any is true`
  3. `GET /api/groups sets hasRequested for the caller's pending request and lazily fulfills once readable`
  4. `POST /api/groups/:name/access-requests → 404 unknown-group, 409 already-readable, 200 + idempotent repeat`
  5. `GET /api/groups/access-requests returns [] for a non-admin and only the administered groups' rows for a folder admin`
  6. `POST dismiss → 403 for non-admin, 404 for unknown/settled, 200 flips pending`
- `packages/core-backend/src/modules/tool-manuals/__tests__/` (extend existing service test file): `listAllSummaries returns every manual regardless of caller access`.

**Frontend** (all in `packages/core-frontend/src/modules/library/__tests__/`)
- `GroupsSidebar.locked.test.tsx`:
  1. `renders locked rows after the spacer with a lock glyph and no count` (query `getByRole('button', { name: 'Finance (locked)' })`)
  2. `clicking a locked row selects { kind: 'locked-group', group }`
  3. `renders no locked section when lockedGroups is empty`
  4. `locked row carries aria-current when selected`
- `LockedGroupView.test.tsx`:
  1. `shows name, Locked badge, run-by line, and the verbatim counts line "2 skills · 1 tool — visible to members only."`
  2. `request button copy is "Subscribe to its skills and tools" and posts once (disabled while in flight)`
  3. `success flips to the Requested box "Requested — Olga Ivanova decides who joins." and fires the toast "Asked Olga — you get its skills and tools if they let you in."`
  4. `hasRequested groups render the Requested box with no button`
  5. `empty admins → "Run by your workspace admins." / "…your workspace admins decide who joins." / "Asked the admins — …"`
  6. `AlreadyReadableError → calls onUnlocked and shows no error toast`
  7. `canManage renders the quiet "Manage access" button calling onManage with the first folder`
- `AccessRequestsBanner.test.tsx`:
  1. `single request copy "{name} asked to join {group} — grant read access to let them in."`
  2. `multi-request copy "{n} people asked to join {group}: {names}."`
  3. `one Manage access button for a single folder; "(Skills)"/"(Tools)" variants for two`
  4. `Dismiss (aria-label "Dismiss request from {name}") calls onDismiss with the row id`
  5. `renders null with zero requests`
- `status.test.ts` (extend): `filterLibraryItems returns [] for { kind: 'locked-group' }`; existing cases unchanged.
- `LibraryPage.locked.test.tsx` (mock `useLibraryData`, `useGroupsIndex`, `useGroupAccessRequests`, `useWorkspace`):
  1. `selecting a locked group hides the search field and renders LockedGroupView with the group heading`
  2. `a server-locked group with client-visible items renders as a normal unlocked group row`
  3. `server-known unlocked group with zero visible items still appears in the sidebar`
  4. `admin banner renders on the Everything view for each group with pending requests and on that group's view only`
  5. `Manage access opens ManageAccessDialog with a directory entry at "<kbDirName>/Groups/Finance"; closing it reloads groups + requests`

---

## 8. Edge cases + failure modes

1. **Loading:** sidebar renders without the locked section until `useGroupsIndex` resolves (no spinner — matches current sidebar); LockedGroupView is only reachable after the index exists.
2. **`GET /api/groups` fails / backend pre-M1:** hook degrades to `[]` silently → sidebar shows exactly today's derived groups; nothing locked appears; no error banner (phase-2 degradation asymmetry preserved).
3. **Unmigrated KB (legacy `Skills/`/`Tools/` roots, before KB PR #8):** groups enumerate from both legacy roots and merge by name; lockedness requires ALL constituent folders unreadable; admin banner shows per-folder Manage buttons; after migration the same group has one `Groups/<g>` folder and the UI collapses to one button with zero code change.
4. **Tool with no group (`Tools/slack.tool`):** unchanged — ungrouped, counts nowhere, lives under "Yours alone".
5. **Group folder with zero items:** appears (unlocked: plain row, no count badge, empty-state copy "Nothing here matches yet."; locked: "0 skills · 0 tools — visible to members only." — honest and harmless).
6. **Item-level grant inside a locked folder:** server says `locked`, but the caller sees the item; client precedence rule renders the group unlocked (row + partial contents). Documented in §5(c).
7. **403/permission races:** request POST after being granted → 409 `already-readable` → silent library refresh, group unlocks. Dismiss after another admin dismissed/grant fulfilled → 404 → toast `Couldn't dismiss that — try again.` + list reload.
8. **Requester loses the race the other way** (request granted then revoked): the fulfilled row stays fulfilled; the user may request again (new pending row) — partial unique index only constrains *pending*.
9. **Group renamed/deleted while requests pend:** rows reference a name no longer in the catalog → hidden from both surfaces (never 500); they linger as pending in the DB (audit-visible). Acceptable for v1; noted in risks.
10. **Duplicate group names across roots** (`Groups/GTM` + `Skills/GTM`): by design one merged group (matches `groupOfPath` collapsing them for items).
11. **Admins list empty** (no `owner:` anywhere on the chain): copy fallbacks in §2.2; the request is still receivable by platform Admins (admin-rescue passes the `canWrite` gate on `access.md`).
12. **Platform Admin who cannot READ a locked group:** sees it locked (read has no admin rescue — correct) but gets `canManage: true` → `Manage access` self-service.
13. **DB down:** `GET /api/groups` still serves discovery with `hasRequested:false` (warn-and-degrade); POST/dismiss return 500 → button re-enables with the failure toast.
14. **Restart:** requests are Postgres rows — the prototype's "Requested resets on reload" bug is explicitly fixed.
15. **Cache staleness:** lockedness reflects grants within one Subscriber-A invalidation (grant commits touch `Groups/**` on the default branch) or the 60s TTL, matching skills/tools freshness.
16. **Secrets:** feature never reads, renders, or posts secret values; no vault surface is touched.

---

## 9. Acceptance criteria checklist

- [ ] `GET /api/groups` returns every group folder (Groups/ + legacy roots) with `locked` computed per-caller via `canReadBatch` on `<folder>/access.md` probes, fail-closed.
- [ ] Locked entries expose ONLY name, folders, counts, admin display names, `hasRequested`, `canManage` — a test asserts no `@` appears anywhere in a locked entry.
- [ ] Item listings (`/api/skills`, `/api/tools`, agent surfaces) are byte-for-byte unchanged for locked content.
- [ ] Sidebar: locked rows render after a 14px gap, lock glyph in the count box, no counts, no amber, `aria-label="{name} (locked)"`.
- [ ] Locked page shows, in order: h1 + `Locked` badge, `Run by {admins}.`, `"{n} skills · {n} tools — visible to members only."` (verbatim), then button `Subscribe to its skills and tools` (verbatim) OR box `Requested — {admins} decides who joins.` (verbatim).
- [ ] Success toast is `Asked {firstNames} — you get its skills and tools if they let you in.` (verbatim).
- [ ] Requesting twice creates one pending row (DB partial unique index); `hasRequested` survives reload and server restart.
- [ ] `GET /api/groups/access-requests` returns rows only for groups where the caller can write the folder's `access.md`; platform Admin always qualifies; non-admins get `[]`, not 403.
- [ ] Admin banner appears on Everything + the group's view, with `Manage access` opening the existing `ManageAccessDialog` on the group DIRECTORY; granting read retires the request lazily (no new approve endpoint); Dismiss works and is admin-gated (403 otherwise).
- [ ] No new KB write path: all new endpoints write Postgres only; the only KB write remains the existing grant/revoke direct-commit flow.
- [ ] No new frontend routes; `/connect`, `/secrets` untouched; Ali's skill page/CR modules untouched (`git diff` shows no changes under `modules/pr/`, `modules/review/`, or the skill half of `DetailDialog.tsx`).
- [ ] `pnpm ds:check` passes with no baseline increases; only barrel primitives + semantic tokens in new UI code.
- [ ] All tests in §7 exist at the stated paths and pass; primitives' frozen a11y contract untouched.
- [ ] Migration `0002_group_access_requests.sql` applies idempotently on boot after `0000` and `0001`.

---

## 10. Open risks + fallback moves

1. **`eligibleOwners(wsId, '<folder>/access.md')` shape.** Verified that own-frontmatter is skipped for `access.md` paths, so the folder chain decides — but if owner resolution on that probe behaves unexpectedly (e.g. returns file-kind sources), fall back to the routes' `resolvedView` approach: call `eligibleOwners` with the folder's deepest child convention used by `GET /workspace/:id/access?kind=folder` (read `resolvedView` in `access.routes.ts:353` and mirror its folder-target path exactly). Isolated inside `GroupIndexService.catalog()`; contract unchanged.
2. **`canReadBatch` probe on a possibly-nonexistent `access.md`.** Verified `readOwnEntries` returns null on read failure and skips `access.md` regardless; if a regression appears, switch the probe to `<folder>/.__probe__` (same chain, guaranteed-null own-entries) — one constant change + tests.
3. **Route-shape collision with the sibling "group pages" feature.** If that feature routes groups at `/skills-and-tools/groups/:group`, move the locked branch into its route element: `LockedGroupView` is prop-driven and mount-agnostic; only LibraryPage's dispatch changes. Coordinate on the `LibraryFilter` extension — if they replace filter-state with URLs, `{ kind: 'locked-group' }` dies and the sidebar `onSelect` navigates instead.
4. **Metadata exposure policy reversal** (a customer wants truly-invisible groups). All exposure funnels through `GET /api/groups`; add a per-folder opt-out (e.g. `access.md` frontmatter `discovery: hidden`) that drops the entry for non-readers — additive, no UI change for the default.
5. **Drizzle partial-index `onConflictDoNothing` targeting.** If the installed drizzle version rejects `targetWhere` on the conflict clause, use plain `onConflictDoNothing()` (no target) — the partial unique index still enforces idempotency at the DB and the insert becomes a no-op; the service test pins the observable behavior either way.
6. **`ManageAccessDialog` directory entry construction from outside the file tree.** It only consumes `entry.name/relativePath/type` (verified props + `targetKind` derivation); if it turns out to require a live `FileTreeEntry` with children, pass `children: []` — the type marks it optional. If the KB-root-strip logic rejects the synthetic path, mirror `DetailDialog`'s existing entry construction for skills (Ali's half already builds one).
7. **Prototype-copy drift** ("subscription" vocabulary elsewhere). Only the four verbatim strings in §2.2 are ported; if product later renames the button (e.g. "Ask to join"), it is one constant in `LockedGroupView.tsx` + two test strings.
8. **Stale pending rows for deleted groups** (edge case 9). If audit noise matters, add a sweep (`dismiss` with `resolvedByEmail='system:group-deleted'`) inside `GET /api/groups/access-requests` when the catalog lookup misses — 5 lines, no contract change.
