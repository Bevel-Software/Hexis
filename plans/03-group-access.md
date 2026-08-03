# Feature Design — Manage Access for Groups

Repo: `/Users/empire23/CodeBases/skill-and-tool-management`, branch `skills-and-tools-ui`.
Owner: Juan. Scope: GROUP-level access surface only. Ali owns the skill page, the change-request flow, and the Share-panel-on-item-page (his lens work); nothing in this design touches `modules/pr/`, `modules/review/`, or the skill half of `DetailDialog`.

---

## 1. Goal + non-goals

**Goal.** Give a group (a KB folder derived via `groupOfPath()` — `Groups/<G>/`, or legacy `Skills/<G>/` + `Tools/<G>/`) a visible, editable access surface on its group page: (a) a read-only "who can use / who can change / owners" summary built from the existing access API (`GET /api/workspace/:id/access?kind=folder`), (b) a "Manage access" escalation for callers whose resolved `canWrite` on the folder is true, which opens the existing `ManageAccessDialog` pointed at the group folder (it already fully supports directory targets and edits exactly `<folder>/access.md`), and (c) an "Item-specific rules" display listing every access declaration that lives *inside* the group (descendant `access.md` files, skill/`.tool` frontmatter verbs) so an admin is never misled into thinking the folder's `access.md` is the whole story. Writes land exactly as the repo already lands them: edit-lock → surgical splice → `releaseLock` background **direct commit + push on the workspace branch** (including the protected default branch, commit-as-user), gated fail-closed by `assertCanMutate` (resolved `canWrite` on the folder's `access.md`).

**Non-goals.** No new resolver semantics — closeness-first resolution, deny-prefix entries, admin-rescue on `access.md`, `roles.yaml` admin-only-write all stay untouched; this feature only *surfaces and edits* existing rules through existing mutation endpoints. No change-request path for access edits: the repo has none (grant/revoke always direct-commit; non-writers get a hard 403), and this feature follows those semantics exactly rather than inventing a CR fallback. No "request access" flow (nothing in the repo supports it; Juan's prototype's "Subscribe" button is explicitly out of scope for this feature). No per-item access *editing* from the group page (per-item share belongs to Ali's item-page lens); per-item rules are displayed read-only here. No roles/member management (that stays on `/roles-and-members`); groups are folders, not roles — the UI copy never conflates the roles roster (Admin, Architect, Developer, Agent, GTM Team) with group folders (Everyone, GTM, Engineering, Product). No secret handling of any kind (this feature never touches secret values). No migration of legacy `Skills/`/`Tools/` roots — mid-migration state is displayed honestly instead.

---

## 2. UX spec

### 2.1 Where it lives

The **group page** at `/skills-and-tools/groups/:group` (see §3 for the contract) gets a new final section, rendered after the Skills and Tools grids:

```
┌─ ACCESS ─────────────────────────────────────────────────────┐
│ [Surface card — one per physical folder, usually exactly one]│
│                                                              │
│  Who can use this group                     [Manage access]  │
│  Everyone at the company can use this group.                 │
│    — or, when restricted —                                   │
│  [GTM Team] [Developer]  Alice Chen · Bob Ruiz               │
│                                                              │
│  Can edit                                                    │
│  [Admin]  Olga Petrov                                        │
│                                                              │
│  Owners                                                      │
│  Olga Petrov                                                 │
│                                                              │
│  ITEM-SPECIFIC RULES                                         │
│  Rules on an item override this folder's rules for the       │
│  people and groups they name.                                │
│  · Competitor battlecards   [Own rules]                      │
│      write: GTM Team · deny read: Everyone                   │
│  · slack.tool               [Own rules]                      │
│      owner: Ali <ali@bevel.software>                         │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Section order and exact copy

Section wrapper: `<section aria-label={`Access for ${group}`}>` with heading `Access` (styled `text-label uppercase tracking-wider text-ink-faint`, matching the page's other section heads).

**Per-folder card** (`Surface` tone `surface`, radius `xl`, elevation `card`, `padded`). One card per physical folder returned by `groupFoldersFor()` (§4.3). When there is more than one card, each card gets a sub-heading naming its folder — exactly `Skills folder — Skills/{G}`, `Tools folder — Tools/{G}`, `Groups folder — Groups/{G}` (`text-meta text-ink-muted`) — and the whole section is preceded by this Banner (tone `neutral`, `role="note"`):

> **This group still lives in the legacy Skills/ and Tools/ folders, so its skills and its tools have separate access rules. Manage each folder below; they become one when the group is migrated to Groups/.**

Card contents, top to bottom:

1. **Header row** — heading `Who can use this group` (`text-strong`) left; right slot:
   - If `access.canWrite === true`: `<Button variant="outline" size="sm">Manage access</Button>` (label verbatim from Ali's prototype vocabulary and the existing dialog).
   - Else: nothing in the right slot; instead a trailing line below the lists (see 4).
2. **Readers** — from `AccessResponse.readers`:
   - `readers.restricted === false` → single line, verbatim: `Everyone at the company can use this group.`
   - `restricted === true` → role names as `Badge tone="outline" size="sm"` chips, then user display names joined with ` · ` (`text-body text-ink`). Empty both → `Nobody has been given access yet — Admins can always see it.`
3. **Writers + owners** — two labelled sub-blocks (`text-label uppercase` labels):
   - `Can edit` → `eligible.roles` badges + `eligible.users` names. Empty → `Only Admins can change this group.`
   - `Owners` → `owners.roles` badges + `owners.users` names. Empty → omit the whole sub-block (no empty "Owners" label).
4. **Non-writer trailing line** (only when `canWrite === false`), verbatim:
   - owners.users non-empty → `Managed by {names joined ', '}. Ask them to change access.`
   - otherwise → `Managed by the Admins. Ask an Admin to change access.` (matches Ali's prototype line "Ask an Admin to change access.")
5. **Item-specific rules** — rendered only when the overrides fetch returned ≥ 1 entry:
   - Heading `Item-specific rules` (`text-label uppercase`), lede verbatim: `Rules on an item override this folder's rules for the people and groups they name.` (This is the accurate closeness-first phrasing — do NOT say "always win" or "take precedence over everything".)
   - `<ul aria-label="Item-specific rules">` of `ListRow` (`as="li"`, density `row`): `label` = last path segment of `governs` with extension stripped for `.md` (keep `.tool` extension visible); `description` = entries summary, each entry formatted `${deny ? 'deny ' : ''}${verb}: ${principalLabel}` joined by ` · `, where principalLabel is the role name, `Everyone`, or `name <email>` for users; `meta` = `Badge tone="outline" size="xs"` text `Own rules`. A row with `parseError` set renders `meta` = `Badge tone="danger" size="xs"` text `Unreadable rules` and description = the parseError string.
   - Rows are display-only — no buttons, no per-item Manage (Ali's boundary). No navigation is required; if trivially available, `meta` may additionally include a quiet `View in workspace` link built with `kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${override.path}`)` — optional, cut first if contentious.
   - If `truncated === true`, append line: `Showing the first rules found — this group has too many files to scan completely.`
6. **States**:
   - Loading: `Checking access…` (`text-detail text-ink-muted`) in place of the card body.
   - Load error: `Banner tone="danger" role="alert"` text `Couldn't load access for this group.` + `<Button variant="quiet" size="sm">Try again</Button>` calling `reload()`.
   - Overrides fetch failing (incl. 403): the "Item-specific rules" block is simply omitted; the summary still renders.

### 2.3 Manage escalation

Clicking **Manage access** opens the existing `ManageAccessDialog` with a synthetic directory entry:

```ts
{ name: group, relativePath: `${kbDirName}/${folder}`, type: 'directory' } satisfies FileTreeEntry
```

plus the new `workspaceId={DEFAULT_WORKSPACE_ID}` prop (§4.2) so the edit always targets the default branch, regardless of whichever branch the ambient WorkspaceContext last had open. The dialog needs **no other change**: `entry.type === 'directory'` → `kind: 'folder'` → all grants/revokes splice exactly `<folder>/access.md` (ManageAccessDialog.tsx L229-236), suggestions, verb checklists, remove-from-parent, deny-here, and the inherited-409 confirm flow all already work for folders. On dialog close → `reload()` the summary + overrides.

If `kbDirName` is still null (workspace bootstrapping), the button renders disabled with `title="Workspace still loading"`.

### 2.4 Who sees what, by role

| Viewer | Summary | Manage button | Item-specific rules |
|---|---|---|---|
| Admin | full (canWrite true via admin-rescue on any access.md) | yes | yes |
| Non-admin with resolved write on `<folder>/access.md` (e.g. explicitly granted `write`/`owner` on the folder) | full | yes | yes (if they can read the folder) |
| Member who can read the folder but not write | full summary + "Managed by …" line | no | yes |
| User who can read some items via item-level grants but NOT the folder | summary renders whatever the API returns (existing `resolvedView` discloses lists to any authenticated caller — we mirror, not tighten); overrides endpoint 403s → block hidden | no | hidden |

Admin-ness is never checked client-side for this feature — the gate is purely `AccessResponse.canWrite` on the folder target, which is what the backend enforces at mutation time anyway (`assertCanMutate`, fail-closed).

### 2.5 Write semantics — stated exactly

The repo's existing semantics for access edits, which this feature follows verbatim and does not extend: `POST /access/grant` / `POST /access/revoke` → `assertCanMutate` requires the caller's **resolved canWrite on the edit path** (folder → its `access.md`; admins always pass via rescue) and fails closed with 403 + eligible-writers payload otherwise → `withEditLock` acquires the workflow edit-lock on `knowledge-base/<folder>/access.md` → splice → `releaseLock` enqueues a **direct commit + push on the workspace's branch, commit-as-user — including the protected default branch. There is no change-request path for access edits anywhere in the repo, so "non-owners go through a change request" does not apply: non-writers never see the editor (button hidden) and would be 403'd by the backend if they called anyway.** The plan-level requirement "follow the repo's existing semantics exactly" is satisfied by exactly this: direct commit for anyone the write-gate admits, hard 403 for everyone else, no CR.

---

## 3. Routes + navigation contract

**This feature adds zero frontend routes.** It contributes a section component mounted on the group page.

**Contract (Ali + the group-page feature build against this):**
- Group page: `GET /skills-and-tools/groups/:group` — `:group` is `encodeURIComponent(<folder segment>)`, e.g. `/skills-and-tools/groups/GTM`. Nested `<Routes>` live inside the Library app element (the shell already mounts `/skills-and-tools/*`, CoreAppShell.tsx:295 — no shell change).
- Item pages (Ali's, for reference only): `/skills-and-tools/skills/:name`, `/skills-and-tools/tools/:slug`. This feature never links to them.
- Backend: one NEW endpoint `GET /api/workspace/:id/access/overrides` (§4.4). All existing access endpoints used as-is.

**Mount point decision** (must be unambiguous for autonomous agents):
- **Primary**: if `packages/core-frontend/src/modules/library/components/GroupPage.tsx` exists at implementation time (created by the group-page feature of this plan), render `<GroupAccessSection group={group} itemPaths={itemPaths} />` as the last child of its page body, after the Tools section.
- **Fallback (interim, independently shippable)**: if GroupPage does not exist yet, mount in `LibraryPage.tsx` (`LibraryPageInner`): immediately after the card-grid container, add
  ```tsx
  {filter.kind === 'group' && (
    <GroupAccessSection
      group={filter.group}
      itemPaths={items.filter((i) => i.group === filter.group).map((i) => i.path)}
    />
  )}
  ```
  This requires threading `path` onto the local `GalleryItem` (one added field: `path: string` = `s.path` / `t.path`; module-private, safe). When GroupPage lands, the mount moves — one JSX line.

---

## 4. Data + API design

### 4.1 Existing endpoints used as-is

| Call | Use |
|---|---|
| `GET /api/workspace/:id/access?path=<folder>&kind=folder` → `AccessResponse` | the read-only summary + the `canWrite` gate. Called via existing `fetchFileAccess(DEFAULT_WORKSPACE_ID, folder, 'folder')` (`modules/access/api.ts:176`). `:id` is always `DEFAULT_WORKSPACE_ID` (`library.api.ts:19`). |
| `GET /api/workspace/:id/access/suggest`, `POST …/access/grant`, `POST …/access/revoke` | used only *inside* the unmodified `ManageAccessDialog`. |

`AccessResponse` fields consumed: `canWrite`, `readers` (`{roles, users, restricted}`), `eligible` (writers), `owners`. `sources`/`downloaders` unused by the summary (the dialog uses them internally).

### 4.2 `ManageAccessDialog` — the one change it needs

The dialog already supports folder targets end-to-end. The single gap: it reads `workspaceId` from `useWorkspace()`, which reflects the *currently open workspace branch* — from the Library we must always edit the default branch. Additive, optional prop:

```ts
// packages/core-frontend/src/modules/access/components/ManageAccessDialog.tsx
interface Props {
  entry: FileTreeEntry;
  onClose: () => void;
  /** Override the workspace (branch id) whose access is read and edited.
   *  Defaults to the ambient WorkspaceContext. Library surfaces pass
   *  DEFAULT_WORKSPACE_ID so group access always targets the default branch. */
  workspaceId?: string;
}
```
Implementation: `const { workspaceId: ctxWorkspaceId, kbDirName } = useWorkspace(); const workspaceId = workspaceIdProp ?? ctxWorkspaceId;` — every existing call site is unaffected (prop optional). `kbDirName` stays context-sourced (same across branches). This is the complete answer to "what, if anything, ManageAccessDialog needs": nothing for directory targeting, one optional prop for branch pinning.

### 4.3 Group → physical folders (frontend util, no network)

```ts
// packages/core-frontend/src/modules/library/utils/group-folders.ts
import { GROUPS_DIR, LEGACY_SKILLS_DIR, LEGACY_TOOLS_DIR } from '@bevel-software/platform-shared';
export interface GroupFolder { folder: string; root: 'Groups' | 'Skills' | 'Tools' }
/** Physical KB folders backing a logical group. SUPERSEDED as the page's source:
 *  `GroupSummary.folders` now arrives from the backend's folder scan, so a group
 *  with no items still reports its folder. Kept for callers that only hold item
 *  paths. Mirrors groupOfPath(): seg0 ∈ GROUP_ROOTS, seg1 === group, ≥3 segments.
 *  Order: Groups, Skills, Tools. Deduped. Empty input → []. */
export function groupFoldersFor(group: string, itemPaths: string[]): GroupFolder[]
```
Post-KB-PR-#8 this returns `[{folder: 'Groups/GTM', root: 'Groups'}]`; unmigrated KB returns `Skills/GTM` and/or `Tools/GTM`; mid-migration returns up to three, each rendered as its own card (§2.2).

### 4.4 NEW endpoint — access declarations inside a folder

**`GET /api/workspace/:id/access/overrides?path=<folder>`**

- **Where**: added in `packages/core-backend/src/modules/access/access.routes.ts` (inside `createAccessRoutes`), logic in a new module `access-declarations.ts`. Backend changes live in `packages/core-backend` only.
- **Auth gating (explicit)**: behind the existing auth middleware (mounted at `/api`, create-core-server.ts:290). Then: `accessControl.canRead(workspaceId, user.email, folderRepoRel)` must be true, else **403** `{ error: 'You do not have access to this folder.' }`. No admin requirement — this endpoint *discloses less* than the existing `GET /access` (which returns full eligible lists to any authenticated caller); additionally each result row is read-filtered: `accessControl.canReadBatch` over the `governs` paths, rows the caller can't read are dropped.
- **Path handling**: `toRepoRelative` (routes L117) — accepts workspace-relative (`knowledge-base/Groups/GTM`) or repo-relative (`Groups/GTM`); rejects `..`/absolute/backslash/NUL with 400 `{ error }` exactly like the sibling routes. Folder targets only; a `path` resolving to a file → 400.
- **Semantics**: pure read/display. Walks the folder's subtree in the workspace clone and reports every *declaration site*, using only existing parsers — zero new resolver semantics:
  - every `access.md` in a **descendant** directory (the folder's own `<folder>/access.md` is EXCLUDED — that is the main summary), parsed with `parseAccessFile` (currently module-private in `access-control.service.ts:490` — add `export`);
  - every `*.md` and `*.tool` file in the subtree whose own frontmatter declares any of the four verbs, parsed with the already-exported `parseOwnAccessEntries` (`access-control.service.ts:567`).
- **Response 200**:
```ts
{
  overrides: Array<{
    path: string;      // repo-relative declaring file, e.g. 'Groups/GTM/battlecards/access.md' or 'Groups/GTM/slack.tool'
    governs: string;   // what it rules: the containing folder for access.md, the file itself for frontmatter
    source: 'access-md' | 'frontmatter';
    entries: Array<{
      verb: 'read' | 'write' | 'download' | 'owner';
      deny: boolean;   // from the literal 'deny ' prefix (DENY_PREFIX)
      principal: { kind: 'role'; role: string }
               | { kind: 'user'; email: string; name: string }
               | { kind: 'everyone' };
    }>;
    parseError?: string; // set (with entries: []) when an access.md fails to parse — surfaced, not hidden
  }>;
  truncated: boolean;  // true when the scan hit the file cap
}
```
  Mapping: `ParsedEntry` role entries whose canonical name is `everyone` map to `{kind:'everyone'}`; user entries map name/email through; entry order preserved per file; overrides sorted by `path` asc. Malformed frontmatter on ordinary nodes → skipped silently (matches the forgiving resolver); malformed `access.md` → included with `parseError` (admins must see broken rule files).
- **Implementation notes**: `workspaceService.listFiles(workspaceId)` for the tree (workspace-relative paths; navigate to `${kbDirName}/${folder}`), `workspaceService.readFile` per candidate. Candidates = descendant `access.md` files + all `.md`/`.tool` files. Hard cap **400 file reads**; past it, stop and set `truncated: true`. No caching in v1 (group folders are small); the module deliberately does NOT reach into `AccessControlService`'s private model so `IAccessControl` (which enterprise may implement) stays unchanged.

```ts
// packages/core-backend/src/modules/access/access-declarations.ts
export interface AccessDeclaration { path: string; governs: string; source: 'access-md' | 'frontmatter'; entries: DeclarationEntry[]; parseError?: string }
export async function listAccessDeclarationsUnder(
  workspaceService: IWorkspaceService,
  workspaceId: string,
  kbDirName: string,
  folderRepoRel: string,
): Promise<{ overrides: AccessDeclaration[]; truncated: boolean }>
```

### 4.5 Frontend client + hook

```ts
// MODIFY packages/core-frontend/src/modules/access/api.ts — append:
export type AccessOverridePrincipal =
  | { kind: 'role'; role: string } | { kind: 'user'; email: string; name: string } | { kind: 'everyone' };
export interface AccessOverrideEntry { verb: GrantVerb; deny: boolean; principal: AccessOverridePrincipal }
export interface AccessOverride { path: string; governs: string; source: 'access-md' | 'frontmatter'; entries: AccessOverrideEntry[]; parseError?: string }
export async function fetchAccessOverrides(workspaceId: string, folder: string):
  Promise<{ overrides: AccessOverride[]; truncated: boolean }>
// GET /api/workspace/${workspaceId}/access/overrides?path=${encodeURIComponent(folder)} via authFetch + handleApiResponse
```

```ts
// CREATE packages/core-frontend/src/modules/library/hooks/useGroupAccess.ts
export interface GroupFolderAccess {
  access: AccessResponse | null;
  overrides: AccessOverride[];      // [] until loaded or on overrides failure
  truncated: boolean;
  loading: boolean;                  // true only while the SUMMARY fetch is in flight
  error: string | null;              // summary fetch error only; overrides errors degrade to []
  reload(): void;
}
export function useGroupFolderAccess(folder: string): GroupFolderAccess
```
Behavior: on mount / `reload()` / folder change, fire `fetchFileAccess(DEFAULT_WORKSPACE_ID, folder, 'folder')` and `fetchAccessOverrides(DEFAULT_WORKSPACE_ID, folder)` in parallel; the summary failing sets `error`; the overrides call failing (incl. 403) is caught → `overrides: []`. Cancellation guard on unmount (same pattern as ManageAccessDialog's effect). Deliberately NOT `useFileAccess` — that hook default-allows on error and short-circuits non-KB paths; here we want explicit truth for a display surface.

### 4.6 Storage

No new storage. All truth stays in git: `Groups/<G>/access.md` (and legacy `Skills/<G>/access.md` / `Tools/<G>/access.md`), node frontmatter, `roles.yaml` — written only through the existing mutation service. No secrets touched anywhere; nothing secret is ever fetched or rendered.

---

## 5. File-by-file work plan

### Backend (`packages/core-backend`)

1. **MODIFY** `src/modules/access/access-control.service.ts`
   - Add `export` to `function parseAccessFile(...)` (L490). No behavior change.
2. **CREATE** `src/modules/access/access-declarations.ts`
   - `listAccessDeclarationsUnder(...)` per §4.4: tree walk, candidate selection (`access.md` descendants excluding the root folder's own; `.md`/`.tool` frontmatter via `parseOwnAccessEntries`), entry mapping (`ParsedEntry` → wire shape, canonical `everyone` → `{kind:'everyone'}`), 400-file cap, deterministic sort.
3. **MODIFY** `src/modules/access/access.routes.ts`
   - New route `router.get('/workspace/:id/access/overrides', …)` before the mutation routes: resolve user (same helper as siblings) → `toRepoRelative` + folder assertion → `accessControl.canRead` gate (403) → `listAccessDeclarationsUnder` → `canReadBatch` filter on `governs` → `res.json({ overrides, truncated })`; errors through the existing `toHttpError`.

### Frontend (`packages/core-frontend`)

4. **MODIFY** `src/modules/access/api.ts` — append types + `fetchAccessOverrides` (§4.5).
5. **MODIFY** `src/modules/access/components/ManageAccessDialog.tsx` — optional `workspaceId` prop (§4.2), `props.workspaceId ?? ctx.workspaceId` at L193.
6. **CREATE** `src/modules/library/utils/group-folders.ts` — `GroupFolder`, `groupFoldersFor` (§4.3).
7. **CREATE** `src/modules/library/hooks/useGroupAccess.ts` — `useGroupFolderAccess` (§4.5).
8. **CREATE** `src/modules/library/components/GroupAccessSection.tsx`
   ```tsx
   export interface GroupAccessSectionProps { group: string; itemPaths: string[] }
   export function GroupAccessSection({ group, itemPaths }: GroupAccessSectionProps)
   // internal, not exported:
   function GroupAccessCard({ group, folder, showFolderLabel }:
     { group: string; folder: GroupFolder; showFolderLabel: boolean })
   function PrincipalChips({ roles, users }: { roles: string[]; users: { name: string; email: string }[] })
   function OverridesList({ overrides, truncated }: { overrides: AccessOverride[]; truncated: boolean })
   ```
   - `GroupAccessSection`: folders come from the SERVER — `GroupSummary.folders`, which `GroupIndexService` discovered by `readdir` — not from the items' paths. Deriving them from `itemPaths` would make an empty group's access surface disappear, which is exactly the gap §6 used to carry. Renders nothing (`null`) when `folders.length === 0`; legacy Banner when `folders.length > 1`; one `GroupAccessCard` per folder (`showFolderLabel = folders.length > 1`).
   - `GroupAccessCard`: `useGroupFolderAccess(folder.folder)` + `useWorkspace().kbDirName` + local `const [manageOpen, setManageOpen] = useState(false)`. Renders per §2.2. When open:
     ```tsx
     <ManageAccessDialog
       entry={{ name: group, relativePath: `${kbDirName}/${folder.folder}`, type: 'directory' }}
       workspaceId={DEFAULT_WORKSPACE_ID}
       onClose={() => { setManageOpen(false); reload(); }}
     />
     ```
   - Design system only: `Surface`, `Banner`, `Badge`, `Button`, `ListRow` from the barrel; token classes only (`text-label`, `text-meta`, `text-detail`, `text-body`, `text-strong`, `text-ink*`); no raw hex, no slate, no off-scale sizes, no bare `rounded`; compose with `cn()`.
9. **MODIFY** `src/modules/library/components/LibraryPage.tsx` (fallback mount) **or** `GroupPage.tsx` (primary) per §3, plus (fallback case only) add `path: string` to the private `GalleryItem`.

No DELETEs. No changes to `modules/pr/`, `modules/review/`, `DetailDialog.tsx`, or any skill-page file.

---

## 6. Milestones (dependency order; each shippable + verifiable)

**M1 — Backend overrides endpoint.** Items 1-3 + backend tests. Verify: `pnpm --filter core-backend test`; `curl` the route on a seeded workspace returns declarations; 403 for a non-reader. Ships dark (no consumer).

**M2 — Dialog branch pinning.** Item 5 + dialog test. Verify: existing ManageAccessDialog tests green (prop optional ⇒ zero regressions); new test proves prop wins over context. Ships dark.

**M3 — Read-only group access section.** Items 4, 6, 7, 8 (summary + overrides display + legacy multi-card + banner, Manage button rendered but this milestone may ship with it hidden behind `canWrite` as designed — it opens the dialog only after M2, which precedes it) + item 9 mount + frontend tests. Verify: `pnpm --filter core-frontend test`, `pnpm ds:check` (ratchet must not rise), manual: select GTM in the Library → Access section shows readers/writers/owners and item-specific rules.

**M4 — Manage escalation wired end-to-end.** The dialog wiring inside `GroupAccessCard` (open → grant a role → close → summary reflects it after `reload()`), plus the GroupPage mount swap if GroupPage has landed by then. Verify: grant `GTM Team` read on `Groups/GTM` from the group page; confirm a direct commit lands on the default branch touching only `Groups/GTM/access.md`; revoke path and inherited-409 confirm flow work from the folder target.

---

## 7. Test plan (vitest + happy-dom; select on role/aria-label/title only)

**Backend**

`packages/core-backend/src/modules/access/__tests__/access-declarations.test.ts`
- finds a descendant `access.md` and reports `source: 'access-md'`, `governs` = its directory
- EXCLUDES the target folder's own `access.md`
- finds `SKILL.md` frontmatter verbs and `.tool` frontmatter verbs (`source: 'frontmatter'`, `governs` = the file)
- ignores `.md` files with frontmatter but no access verbs (`nodeType:` only)
- maps `deny ` prefix → `deny: true`; canonical `everyone` → `{kind:'everyone'}`; user refs → `{kind:'user', email, name}`
- malformed descendant `access.md` → row with `parseError` and `entries: []`; malformed node frontmatter → skipped
- respects the 400-file cap → `truncated: true`
- empty folder → `{ overrides: [], truncated: false }`

`packages/core-backend/src/modules/access/__tests__/access.routes.overrides.test.ts`
- 200 for a caller with read on the folder; body shape matches §4.4
- 403 for a caller without read on the folder
- rows whose `governs` the caller cannot read are filtered out
- accepts `knowledge-base/Groups/GTM` and `Groups/GTM` equally (toRepoRelative)
- 400 on `..`, absolute path, and a file (non-folder) target

**Frontend**

`packages/core-frontend/src/modules/library/__tests__/group-folders.test.ts`
- `Groups/GTM/x/SKILL.md` → `[{folder:'Groups/GTM', root:'Groups'}]`
- legacy `Skills/GTM/...` + `Tools/GTM/...` → two folders, Groups-first ordering preserved when mixed with `Groups/GTM/...` (three folders)
- `Tools/slack.tool` (2 segments) contributes nothing; other groups' paths filtered; `[]` → `[]`; dedupes

`packages/core-frontend/src/modules/library/__tests__/useGroupAccess.test.tsx` (mock `modules/access/api`)
- exposes summary + overrides after parallel load; `loading` toggles on summary only
- summary rejection → `error` set; overrides rejection → `overrides: []`, no error
- `reload()` refetches both

`packages/core-frontend/src/modules/library/__tests__/GroupAccessSection.test.tsx` (mock `modules/access/api`, mock `ManageAccessDialog` to a stub asserting its props, provide WorkspaceContext with `kbDirName: 'knowledge-base'`)
- shows `Checking access…` while loading, then the readers/writers/owners content
- `readers.restricted === false` → renders "Everyone at the company can use this group."
- `canWrite: true` → button with accessible name `Manage access` present; click → dialog stub received `entry={name:'GTM', relativePath:'knowledge-base/Groups/GTM', type:'directory'}` and `workspaceId=DEFAULT_WORKSPACE_ID`; stub close → both fetches re-fired
- `canWrite: false` → no `Manage access` button; "Managed by" line with owner names (and the Admins variant when owners empty)
- overrides render inside `ul[aria-label="Item-specific rules"]`; a deny entry reads `deny write: Everyone`; `parseError` row shows `Unreadable rules`; zero overrides → block absent; `truncated` → truncation line present
- legacy two-folder input → two cards with `Skills folder — Skills/GTM` / `Tools folder — Tools/GTM` labels + Banner (`role="note"`) with the migration copy
- summary error → Banner `role="alert"` "Couldn't load access for this group." and `Try again` button triggers refetch
- `folders.length === 0` (pseudo-filter / ungrouped) → renders nothing
- `kbDirName: null` → Manage button disabled with `title="Workspace still loading"`

`packages/core-frontend/src/modules/access/__tests__/ManageAccessDialog.test.tsx` (MODIFY, add cases)
- `workspaceId` prop present → all fetch/grant URLs use the prop value, not the context's
- prop absent → existing behavior unchanged (context workspaceId) — guard against regression

---

## 8. Edge cases + failure modes

- **Loading**: summary shows `Checking access…`; Manage never flashes (button only after `canWrite === true` arrives; `canWrite` starts unknown ⇒ hidden).
- **403 / errors on the summary**: danger Banner + Try again. We do NOT default-allow (unlike `useFileAccess`) — this is a display of record, and the backend gate protects writes regardless.
- **403 on overrides**: block silently omitted (viewer can't read the folder's interior — nothing to disclose).
- **Empty access.md / no grants**: readers empty + restricted → "Nobody has been given access yet — Admins can always see it."; writers empty → "Only Admins can change this group." (true via admin-rescue).
- **Unmigrated KB (legacy roots)**: `groupFoldersFor` yields `Skills/<G>` / `Tools/<G>`; two independent cards + migration Banner; each Manage edits its own folder's `access.md`. Mid-migration (both roots) → up to three cards, Groups first. `groupOfPath` accepts all three roots, so derivation is uniform.
- **Tool with no group** (`Tools/slack.tool`, 2 segments → `groupOfPath` null): never reaches a group page; `GroupAccessSection` is only rendered for real group filters/pages, and returns `null` for empty `folders` as a second guard. Its access remains governed by parents/root — out of this surface's scope by design.
- **Pseudo-rows** ("Owned by me", "Everything", "Yours alone"): not groups; section never rendered for them (`filter.kind === 'group'` guard).
- **Empty group folder** (folder exists, no items): **closed** — this was written when groups were derived from items. They are not any more: `GroupIndexService.scanFolders()` enumerates the group roots with `readdir`, so a zero-item group is a real catalog entry with real `folders`, and its page keeps both the `Access` section and `Share`. The rule that replaced the gap: a group EXISTS because a folder exists, and counting is a separate question — the same rule the locked-groups surface needs in order to show a group you cannot read.
- **kbDirName null**: Manage disabled (title tooltip); summary still loads (repo-relative paths don't need kbDirName).
- **Edit-lock 409** ("being edited by …"): surfaced by the dialog's existing `mutateError` path — no new handling.
- **Inherited grant revoke / deny-here rollback (409 inherited / deny-ineffective / stale-ancestor)**: all inside the unmodified dialog, already handled.
- **Corrupted roles.yaml**: global `RolesCorruptedBanner` (admin.context polling) covers it; suggest/grant fail with server errors shown by the dialog. No feature-specific handling.
- **Concurrent external edit of access.md**: `reload()` on dialog close refreshes; SSE `fs-tree-changed` is emitted by the backend but we don't subscribe in v1 (stale-until-reload is acceptable for this surface).
- **Big folder scan**: 400-file cap + `truncated` flag + honest UI line.
- **Group names needing URL encoding**: route contract mandates `encodeURIComponent`; this feature passes raw folder segments to APIs (already `encodeURIComponent`-ed inside the clients).
- **Never render secrets**: this feature touches no secret values, endpoints, or storage — nothing to render.

---

## 9. Acceptance criteria checklist

- [ ] Group page (or interim group-filtered Library view) shows an `Access` section for every real group, with readers, writers, owners from `GET /access?kind=folder` on the default branch.
- [ ] Exact copy per §2.2 (everyone line, empty-state lines, "Managed by …" lines, legacy Banner, truncation line, overrides lede) rendered verbatim.
- [ ] `Manage access` button appears iff `AccessResponse.canWrite === true`; opens the existing `ManageAccessDialog` pointed at the group folder as a directory entry; grants/revokes splice ONLY `<folder>/access.md` and land as a direct commit + push on the default branch, commit-as-user, exactly per existing `withEditLock`/`releaseLock` semantics; non-writers get no editor and the backend 403s fail-closed.
- [ ] `ManageAccessDialog` gains only the optional `workspaceId` prop; all existing call sites and tests unaffected; Library passes `DEFAULT_WORKSPACE_ID`.
- [ ] New endpoint `GET /api/workspace/:id/access/overrides` exists in `packages/core-backend`, auth-gated + `canRead`-gated + `canReadBatch`-filtered, returns the §4.4 contract, uses only existing parsers (`parseAccessFile` exported, `parseOwnAccessEntries`), introduces no resolver changes.
- [ ] Item-specific rules are displayed read-only (no per-item manage affordance from the group page — Ali's boundary respected), including deny entries and unparseable `access.md` files.
- [ ] Legacy `Skills/<G>` / `Tools/<G>` groups render one card per physical folder with folder labels + migration Banner; each is independently manageable.
- [ ] `Tools/x.tool`-style ungrouped items and pseudo-filters render no access section.
- [ ] Only barrel primitives + semantic tokens used; `pnpm ds:check` passes with no baseline increase; no slate, no raw hex, no off-scale text, no bare `rounded`.
- [ ] All tests in §7 exist at the stated paths and pass (`pnpm --filter core-backend test`, `pnpm --filter core-frontend test`); selections use role/aria-label/title only.
- [ ] No files under `modules/pr/`, `modules/review/`, or the skill half of `DetailDialog.tsx` modified.

---

## 10. Open risks & fallbacks

1. **Group-page feature timing.** If `GroupPage.tsx` hasn't landed, the interim LibraryPage mount (§3) ships the full feature standalone; the later move is a one-line JSX relocation. If the group-page feature chooses a different route param name, only the mount call site changes — `GroupAccessSection`'s props are route-agnostic (`group` + `itemPaths`).
2. **`parseAccessFile` export conflicts** (e.g. Ali or another feature touching `access-control.service.ts`). Fallback: `access-declarations.ts` re-implements access.md parsing via the already-exported `extractFrontmatter` + `parseYamlSubset` + `parseAccessEntry` — identical output, no shared-file edit.
3. **`resolvedView` fan-out cost on wide orgs** (one `grantSources` call per principal). We reuse the existing GET unchanged; if group pages make it hot, a follow-up `?lite=1` variant skipping `sources` is the fix — out of scope here, flagged for the backend owner.
4. **Disclosure posture**: the summary shows eligible lists to any authenticated caller because `GET /access` already does. If product later tightens that, tighten it in `resolvedView` for both surfaces — do not fork behavior here.
5. **Ambient workspace assumption**: if some future embedding renders the Library outside `WorkspaceProvider`, `useWorkspace()` throws. Current shell always provides it (ToolDetailBody relies on it today). If that assumption fails, wrap the mount in the provider rather than making the dialog context-optional.
6. **`GalleryItem.path` addition** (fallback mount only) collides trivially with any concurrent LibraryPage refactor — it's a private field; whoever lands second rebases in seconds.
7. **KB PR #8 slips or group folders get renamed**: everything here derives folders from item paths at runtime (`groupFoldersFor`), so no constant depends on the migration state; only the migration Banner copy assumes the destination is `Groups/` — safe.

