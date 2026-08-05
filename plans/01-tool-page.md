# Feature: THE TOOL PAGE with OAuth + Secrets

Repo: `/Users/empire23/CodeBases/skill-and-tool-management`, branch `skills-and-tools-ui`.
All frontend paths below are relative to `packages/core-frontend/src`, all backend paths relative to `packages/core-backend/src`, unless absolute.

---

## 1. Goal + non-goals

**Goal.** Replace the tool half of the Library's `DetailDialog` with a real, routed, deep-linkable tool page at `/skills-and-tools/tools/:slug`, built per Ali's prototype `renderToolItem` (`skills-tools-prototype-ali-version.html` L2073): back link, "Tool · {group}" kicker, title + description lede, a "Your connection" section with per-variable state (admin-scope: "Set by an Admin"/"Not set" chips; user-scope: "Connected" chip or Sign in / Add key actions), real OAuth connect flows for all three MCP setup kinds (open / oauth-auto / oauth-manual), a "What it lets the assistant do" capabilities list, a "Powers these skills" reverse index computed from skills' `allowed-tools` frontmatter, owner-only (`canWrite`) admin-secret editing reusing the existing secrets-vault endpoints, an admin-only "Manage access" affordance opening a Share panel *shell* (contents are Ali's F-lens work — the seam is defined here), and bidirectional deep links with `/secrets` and `/connect`. Two small backend additions make this possible: a browser detail endpoint `GET /api/tools/:slug` (description + capabilities) and an optional `returnTo` on the tool OAuth start route so the provider round-trip lands back on the tool page.

**Non-goals.** No redesign of the skill page, change-request flow, `modules/pr/`, `modules/review/`, or the skill half of `DetailDialog` (all Ali's). No Share-panel contents (Access/People/Link sections, grant editor) — shell + seam only. No merging of `/connect` or `/secrets` into the Library (bucket G is later; this feature only adds links and keeps both routes byte-identical in path). No KB writes: admin secrets go to the Postgres vault via existing endpoints; `.tool` file edits stay in the existing workspace editor (which already enforces protected-branch CR semantics). No changes to `ToolSecretsPanel`, `ToolRenderer`, agent routes, MCP OAuth-server code (`modules/mcp/oauth/`), or the roles model (groups remain folders via `groupOfPath`, never roles/teams). Never render or fetch a stored secret value — write-only inputs posting to existing endpoints only.

---

## 2. UX spec

### 2.1 The Tool page (`/skills-and-tools/tools/:slug`)

Solo-column article, max-width container (`mx-auto w-full max-w-3xl px-6 py-8`), rendered inside the normal app shell (Toolbar stays). Section order top→bottom, copy **verbatim** unless flagged:

**(0) OAuth outcome banner** (only after an OAuth round-trip; see §2.2):
- Success: `Banner tone="ok" role="status"` → `Signed in to {tool.name}.`
- Failure: `Banner tone="danger" role="alert"` → the error message from the `#error=` fragment.

**(1) Back link.** `Button variant="quiet" size="sm"` text `‹ All skills & tools`, navigates to `/skills-and-tools`. (Prototype's label is shelf-state-dependent; a routed page has no shelf state, so we pin the "All" label. Deliberate, flagged deviation.)

**(2) Header block.**
- Kicker (`text-label font-semibold uppercase tracking-wide text-ink-faint`): `Tool · {group}` where `group = groupOfPath(tool.path)` from `@bevel-software/platform-shared`; when `null` (ungrouped / legacy `Tools/x.tool`), render just `Tool`.
- `<h1 className="text-display font-semibold text-ink">{tool.name}</h1>`.
- Lede (`text-lede text-ink-muted max-w-[56ch]`): `detail.description`. Omitted entirely when detail fetch failed or description is null.
- Top-right slot (flex row with header): **admins only** (`useAdmin().isAdmin`): `Button variant="outline" size="sm"` text `Manage access` → opens `ToolSharePanel`. Non-admins get nothing here (prototype-verbatim).

**(3) "Your connection".** Heading row: `<h2 className="text-label font-semibold uppercase text-ink-faint">Your connection</h2>` with a right-aligned `Link` to `/secrets` styled `buttonClasses({variant:'quiet', size:'tiny'})`, text `Open Secrets`.

Setup banner (mcp tools only), directly under the heading:
- `setup.kind === 'oauth-manual'` and the oauth var is not `adminConfigured`: `Banner tone="wait" role="status"`:
  - For `tool.canWrite`: `Sign-in setup needed — this server needs users to sign in, but Bevel couldn't set that up automatically. Declare the OAuth provider in the tool file, then set its client secret below.` followed by `setup.reason` in italic when present, and (when `useWorkspace().kbDirName` is truthy) a `Button variant="quiet" size="tiny"` `Edit the tool file` → `navigate(kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${tool.path}`))`.
  - For everyone else: `Sign-in setup needed — ask the tool's owner to finish setting this up.` plus `setup.reason`.
- `open` / `oauth-auto` / null: no banner.

Variable rows, one `ListRow` (density `row`) per `tool.variables` entry in server order. Empty variables array → single line `text-body text-ink-muted`: `Nothing to set up` (matches current `ToolDetailBody` copy).

Row matrix (`v: ToolVarStatus`, `canWrite = tool.canWrite`):

| Case | Left label | Left sub-copy (`description`) | Right (`meta`) |
|---|---|---|---|
| admin scope, configured | `v.label ?? v.name` | `One value for the whole team — already handled` | `Badge tone="ok"` `Set by an Admin`; **plus, if canWrite:** `Button size="tiny" variant="quiet"` `Replace` and `Button size="tiny" variant="quiet"` `Remove` |
| admin scope, not configured | same | `One value for the whole team` *(deviation: prototype always says "— already handled"; we drop it when unset to avoid contradicting the chip)* | non-writer: `Badge tone="neutral"` `Not set`; writer: `Button size="tiny"` `Set key` |
| user scope, non-oauth, `userConfigured` | same | `Each person sets their own` | `Badge tone="ok"` `Connected` |
| user scope, non-oauth, not configured | same | `Each person sets their own` | `Button size="sm"` `Add key` → inline editor |
| oauth var, `authorized && !needsReauth` | same | `Each person sets their own` | `Badge tone="ok"` `Connected`; **plus, if canWrite && setup?.kind !== 'oauth-auto':** `Button size="tiny" variant="quiet"` `Replace client secret` |
| oauth var, `authorized && needsReauth` | same | `Each person sets their own` | `Button size="sm"` `Sign in again` |
| oauth var, `!authorized`, `adminConfigured` | same | `Each person sets their own` | `Button size="sm"` `Sign in` |
| oauth var, `!authorized`, `!adminConfigured` | same | `The tool owner hasn't finished the sign-in setup yet.` | non-writer: `Badge tone="neutral"` `Not set`; writer: `Button size="tiny"` `Set client secret` |

(Remember the overload: for oauth vars `adminConfigured` means the owner-side provider row exists, not that a shared value exists. For `oauth-auto` setup never show any client-secret affordance — auto-registered PKCE clients have none and saving one would clobber the discovered provider row.)

**Inline editors** (write-only; value never echoed, never fetched):
- Key editor (admin `Set key`/`Replace`, user `Add key`): row expands below with `TextField type="password"` `aria-label={`Value for ${v.name}`}` + `Button variant="primary" size="sm"` `Save` + `Button variant="quiet" size="sm"` `Cancel`. Save calls `setAdminVar(slug, v.name, value)` or `setUserVar(slug, v.name, value)`; on success clear input, close editor, call `onChanged()`. Empty value → Save disabled.
- `Remove` (admin, canWrite): calls `deleteAdminVar(slug, v.name)` directly (no confirm dialog; matches ToolSecretsPanel behavior), then `onChanged()`. Treat HTTP 204 as success.
- Client-secret editor (`Set client secret`/`Replace client secret`): `TextField type="password"` `aria-label={`Client secret for ${v.name}`}` + Save/Cancel; Save calls `setOAuthClientSecret(slug, v.name, value)` then `onChanged()`.
- Sign in / Sign in again: `await startToolOAuth(slug, v.name, { returnTo: `/skills-and-tools/tools/${encodeURIComponent(slug)}` })` then `window.location.href = url`. Button shows busy/disabled while awaiting.
- Any thrown API error → page-level `Banner tone="danger" role="alert"` above section (3) with the error message; cleared on next successful action.

**(4) "What it lets the assistant do".** Rendered only when `detail?.capabilities.length > 0`. Heading same style as (3). `<ul>` of `text-body text-ink-muted` items, each `· {capability.description ?? capability.name}` (prototype bullet format `· {c}` verbatim).

**(5) "Powers these skills".** Heading same style. Reverse index: `skills.filter(s => neededToolsFor({ allowedTools: allowedToolsBySkill.get(s.name) }, [tool]).length > 0)` reusing `modules/library/utils/status.ts`. Render a wrapping flex row of `<Link to={`/skills-and-tools/skills/${encodeURIComponent(s.name)}`} className={buttonClasses({variant:'outline', size:'tiny'})}>{s.name}</Link>` chips. Empty (and skills loaded): `<p className="text-detail text-ink-muted">No skills use this yet.</p>` (verbatim). While skills are still loading, render nothing under the heading (no empty-state flash).

**(6) Ownerline.** `<div className="mt-6 border-t border-line pt-3 text-detail text-ink-faint">Managed by the Admins.</div>` (verbatim).

**Page states:**
- Loading: centered `text-ui text-ink-muted` line `Loading…`.
- Load error (`listToolSecrets` failed): `Banner tone="danger" role="alert"` with message + `Button variant="outline" size="sm"` `Try again` → `reload()`.
- Not found (loaded, no accessible tool with that slug — indistinguishable from 403 by design, fail-closed): kicker `Tool`, then `text-body text-ink-muted`: `This tool doesn't exist, or you don't have access to it.` plus the back link from (1).

### 2.2 OAuth round-trip on the tool page

The tool page implements the frozen fragment contract exactly like `SecretsPage`:
- Read `window.location.hash` **once, synchronously**, in a `useState(readOAuthFragment)` initializer (never in an effect — the stripper would race it): `#authorized[=id]` → `{kind:'authorized'}`; `#error=<msg>` → `{kind:'error', message}` via `new URLSearchParams(hash.slice(1))` with **no** extra `decodeURIComponent` (double-decoding corrupts `%`).
- Strip in an effect: `window.history.replaceState(null, '', window.location.pathname)`.
- Outcome renders as the banner in §2.1(0); it is state separate from API errors so a successful data load can't clear it.

### 2.3 Share panel shell (seam for Ali)

`ToolSharePanel` — `Dialog` (`size="2xl"` default is fine; use `size` default), `title` = `Share tool` (verbatim, lowercase "tool"). Body in this feature:
```
<p className="text-body text-ink-muted">Access, ownership, and roles for <strong>{tool.name}</strong>.</p>
<div data-testid="tool-share-panel-body" />
```
Footer: `Button variant="outline"` `Done` → `onClose()`.
**Seam contract (Ali):** Ali replaces the `data-testid="tool-share-panel-body"` placeholder with the F-lens contents (Access / People / Link-access sections, admin "Manage access" footer fork). He must keep the component path, exported name, and props `{ open: boolean; tool: { slug: string; name: string; path: string }; onClose(): void }` stable; Juan's ToolPage and tests depend only on those plus the dialog title.

### 2.4 Deep links on `/secrets` and `/connect`

- `SecretsPage.tsx:140` — the tool-name `<span className="text-xs font-semibold text-ink">{tool.name}</span>` becomes `<Link to={`/skills-and-tools/tools/${encodeURIComponent(tool.slug)}`} className="text-xs font-semibold text-ink hover:underline" aria-label={`Open ${tool.name}`}>{tool.name}</Link>`. `ToolSecretsPanel` itself is untouched.
- `ConnectToolsPage.tsx` — wherever a pending tool's name renders (plain mode tool list rows and toolOAuth sign-in rows), wrap the name in the same `Link` pattern (`aria-label={`Open ${name}`}`). Agent-connect mode (`?oauth=` present) keeps names as links too — harmless — but no other agent-mode behavior changes (sessionStorage `mcp-oauth-state`, Finish flow, empty-pending-as-success branch all untouched).
- Tool page → `/secrets`: the `Open Secrets` quiet link in §2.1(3).

### 2.5 Who sees what

Roles in `roles.yaml` (Admin, Architect, Developer, Agent, GTM Team) never gate UI directly; the page uses exactly three signals:
- **Everyone with read access to the `.tool`** (fail-closed via `GET /api/secrets/tools` / `listAccessible`): sections 1–6, user-scope connect actions, admin-scope status chips, Open Secrets link. No read access → Not-found state.
- **`tool.canWrite`** (per-file ACL from roles.yaml + access.md + frontmatter, returned by the API): admin-var Set key/Replace/Remove, client-secret editors, "Edit the tool file" link.
- **`useAdmin().isAdmin`** (`GET /api/admin/access`, fail-closed default false): the `Manage access` button. Nothing else.

---

## 3. Routes + navigation contract

**This is the route contract Ali builds against. Flagged as frozen once merged.**

| Route | Owner | Element |
|---|---|---|
| `/skills-and-tools` (index) | Juan | `LibraryPage` (gallery, unchanged UI) |
| `/skills-and-tools/tools/:slug` | **Juan (this feature)** | `ToolPage` — `:slug` is the tool manual slug (`/^[a-z0-9][a-z0-9_]*$/`), `encodeURIComponent`-ed when building links |
| `/skills-and-tools/skills/:name` | **Ali (reserved, NOT built here)** | Skill page. Juan's "Powers these skills" chips link here today; until Ali ships, the catch-all redirects them to the gallery — acceptable interim |
| `/skills-and-tools/*` (catch-all) | Juan | `<Navigate to="/skills-and-tools" replace />` |
| `/connect`, `/secrets` | frozen | Unchanged exact paths — OAuth return targets; never rename or nest (shell gotcha) |
| `/tools` (exact) | untouched | `ToolsExplorerPage` — different page; our nested route does not collide |

Mechanics: `CORE_APPS` in `core/CoreAppShell.tsx` already mounts the app at `/skills-and-tools/*`; we swap `element: <LibraryPage />` → `element: <LibraryRoutes />`, and `LibraryRoutes` owns the nested `<Routes>` with **relative** paths (`index`, `tools/:slug`, `*`). No `ShellRoutes` change. A marked comment line in `LibraryRoutes.tsx` is where Ali inserts his `skills/:name` route.

Navigation into the page: `LibraryPage` card click for `kind === 'integration'` → `navigate(`/skills-and-tools/tools/${encodeURIComponent(item.id)}`)` (item.id is the slug) instead of `setDetail`. Skill cards keep opening the dialog until Ali's page lands.

**`/connect` and `/secrets` NOW vs LATER (bucket G):** NOW — keep both pages and routes exactly as-is; changes are strictly additive (name links per §2.4, `startToolOAuth` gains an optional `returnTo`). LATER — the bucket-G merge is unblocked, not prejudged: (a) the tool page speaks the same `#authorized`/`#error` fragment contract, so any future consolidation can reuse it; (b) `returnTo` generalizes callback destinations without touching route paths; (c) `ToolSecretsPanel` and the agent-connect flow are untouched, so they can be lifted wholesale later. Nothing in this feature assumes `/connect` or `/secrets` will or won't survive.

---

## 4. Data + API design

### 4.1 Existing endpoints used as-is

- `GET /api/secrets/tools` (`listToolSecrets()` from `modules/secrets-vault/services/tool-secrets.api.ts`) — the tool's `ToolSecrets` record: `{slug, name, path, type, setup, canWrite, variables: ToolVarStatus[]}`. Page filters client-side by `slug` (the `?path=` param is path-keyed, not slug-keyed).
- `PUT /api/secrets/tools/:slug/vars/:var/admin`, `PUT .../user`, `DELETE .../admin`, `PUT .../oauth/admin` — via existing `setAdminVar` / `setUserVar` / `deleteAdminVar` / `setOAuthClientSecret`. Server-side gating unchanged: the three admin routes are `accessControl.canWrite`-gated; 422 on wrong scope; 404 on unreadable tool.
- `GET /api/skills` (`listSkills`) + `GET /api/skills/:name` per skill (`getSkill`, N+1 for `allowedTools` — no bulk endpoint exists; accepted cost, degraded per-skill).
- `GET /api/admin/access` via `useAdmin()`.
- Secret values are only ever POSTed to these endpoints; nothing in this feature reads or renders a stored value.

### 4.2 NEW endpoint: browser tool detail

**`GET /api/tools/:slug`** — added to `createToolManualsBrowserRoutes` (`modules/tool-manuals/tool-manuals.routes.ts`), therefore mounted at `create-core-server.ts:303` behind `core.authMiddleware` (JWT). **Auth gating: JWT required (401 `{error:'Not authenticated'}` when `req.userEmail` missing); per-caller read access enforced by resolving through `listAccessible(email)` — unknown slug and no-read-access are both 404 `{error:'Not found'}` (fail-closed, indistinguishable, matching the existing `/tools/:slug/manual` pattern).** No collision with the agent router: it defines only `/tools/:slug/manual` and mounts earlier; unmatched paths fall through.

Response `200`:
```json
{ "tool": {
    "slug": "github", "name": "github", "path": "Groups/Engineering/github.tool",
    "type": "inline", "variables": [...], "remote": true, "setup": null,
    "description": "Read and write GitHub issues and PRs." ,
    "capabilities": [ { "name": "create_issue", "description": "Open an issue in a repo." } ]
} }
```
- `description: string | null` — new optional frontmatter field on `.tool` files (see 4.4).
- `capabilities` — derived server-side from the descriptor's `tools` array (inline manuals): entries that are objects with a string `name`; `description` = string or null; capped at 100. `http`/`mcp` manuals (no browser-visible tool list) → `[]`; the UI hides the section.

Service change: new method on `IToolManualService` + `ToolManualService`:
```ts
getDetail(userEmail: string, slug: string): Promise<ToolManualDetail | null>
// ToolManualDetail = ToolManualSummary & { description: string | null; capabilities: { name: string; description: string | null }[] }
```
implemented over the existing `accessibleManuals(email)` (so cache, dedupe, decoration, and fail-closed access all apply for free).

### 4.3 NEW behavior: `returnTo` on tool OAuth start (backend, `modules/secrets-vault/secrets-vault.routes.ts`)

**`POST /api/secrets/tools/:slug/vars/:var/oauth/start`** now accepts an optional JSON body `{ returnTo?: string }`. **Auth gating unchanged: JWT-authed route; no canWrite check (any reader may authorize their own account); 422 if var is not oauth; 409 if the owner hasn't finished setup.**

- Validation (`isSafeReturnPath`, new helper in the routes file): `typeof returnTo === 'string' && returnTo.length <= 512 && returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.includes('\\') && !returnTo.includes('#') && !/[\r\n]/.test(returnTo)`. Valid → stored as `state.r` (the `OAuthState.r?: string` field already exists and is HMAC-SHA256-signed, so it is tamper-proof). Invalid or absent → `state.r = 'connect'` (today's behavior, byte-compatible).
- Callback (`createSecretsVaultPublicRoutes`, `GET /api/secrets/oauth/callback`): destination resolution becomes: `if (isSafeReturnPath(state.r)) dest = state.r; else if (state.r === 'connect') dest = '/connect'; else dest = '/secrets'` — re-validated at callback time (defense in depth; the browser is redirected to `${publicFrontendUrl}${dest}#authorized=…` / `#error=…`, so the leading-`/`-single-slash rule prevents open redirects). Pre-verification errors still land on `/secrets` unchanged.
- Frontend client (`modules/secrets-vault/services/connect.api.ts`): `startToolOAuth(slug: string, varName: string, opts?: { returnTo?: string })` — sends the JSON body only when `opts?.returnTo` is provided; existing `/connect` call sites unchanged (no body → legacy behavior).

### 4.4 Backend contract additions (tool-manuals)

- `tool-manuals.contract.ts`: add `description?: string` to `ToolManualDescriptor` and `ToolManualSummary`; add exported `ToolManualDetail` interface (above); add `getDetail` to `IToolManualService`.
- `tool-manuals.service.ts` `normalizeToolManual`: parse frontmatter `description` — accepted only when `typeof === 'string'` and non-empty after trim; anything else silently ignored (cosmetic field, must never make a previously-valid `.tool` file skip). Summaries returned by `listAccessible` carry it through.
- `index.ts`: export `ToolManualDetail`.

### 4.5 Storage

None new. No schema change, no new tables, no KB writes. Secrets stay in the existing `secrets` Postgres table via existing service methods. Protected-branch semantics: the only KB-touching affordance is the "Edit the tool file" link into the existing workspace editor, which already routes non-writers through change requests.

### 4.6 Frontend data hook

`modules/library/hooks/useToolPage.ts`:
```ts
export interface ToolPageState {
  loading: boolean;              // until listToolSecrets settles
  error: string | null;          // only listToolSecrets failure
  notFound: boolean;             // settled, no accessible tool with slug
  tool: ToolSecrets | null;
  detail: ToolManualDetail | null;   // GET /api/tools/:slug, degraded to null on any failure
  skillsLoaded: boolean;
  poweredSkills: LibrarySkillSummary[];  // reverse index via neededToolsFor
  reload(): void;                // revision counter re-runs the effect
}
export function useToolPage(slug: string): ToolPageState
```
Fetch plan: phase 1 `listToolSecrets()` (sets loading/error/notFound/tool). In parallel, degraded independently: `getToolDetail(slug).catch(() => null)`; `listSkills().catch(() => [])` then per-skill `getSkill(s.name).catch(() => ({...s, allowedTools: []}))` building `allowedToolsBySkill`, then compute `poweredSkills` with `neededToolsFor` once `tool` is known. Stale-response guard: monotonic request ref (same pattern as `ToolRenderer.loadToolSecrets`). Empty CR/skill data is degradation, never proof of absence — the page treats it as "render nothing", not "render empty-state" (except powered-skills after `skillsLoaded`).

`modules/library/services/tools.api.ts`:
```ts
export interface ToolCapability { name: string; description: string | null }
export interface ToolManualDetail { slug: string; name: string; path: string; type: 'inline'|'http'|'mcp'; description: string | null; capabilities: ToolCapability[] }
export async function getToolDetail(slug: string): Promise<ToolManualDetail>  // GET /api/tools/:slug via authFetch, unwrap {tool}
```

---

## 5. File-by-file work plan

### CREATE — backend
1. **`packages/core-backend/src/modules/tool-manuals/__tests__/tool-manuals.detail.route.test.ts`** — tests for `GET /api/tools/:slug` (cases in §7).
2. **`packages/core-backend/src/modules/secrets-vault/__tests__/oauth-return-to.route.test.ts`** — tests for `returnTo` start/callback behavior (cases in §7).

### MODIFY — backend
3. **`modules/tool-manuals/tool-manuals.contract.ts`** — `description?: string` on `ToolManualDescriptor` + `ToolManualSummary`; new `ToolManualDetail`; `getDetail(userEmail, slug)` on `IToolManualService`.
4. **`modules/tool-manuals/tool-manuals.service.ts`** — parse `description` in `normalizeToolManual` (string/trim/else-ignore); implement `getDetail` over `accessibleManuals` (summary fields + `description ?? null` + capabilities derived from `descriptor.tools`, cap 100, non-object/nameless entries skipped).
5. **`modules/tool-manuals/tool-manuals.routes.ts`** — in `createToolManualsBrowserRoutes`: `router.get('/tools/:slug', …)` → 401 without email, `await toolManualService.getDetail(email, req.params.slug)`, null → 404 `{error:'Not found'}`, else 200 `{tool}`. 500 `{error:'Failed to load tool'}` on throw. **Register it BEFORE any future conflicting route; note `POST /tools/preview` is a different method, no conflict.**
6. **`modules/tool-manuals/index.ts`** — export `ToolManualDetail`.
7. **`modules/secrets-vault/secrets-vault.routes.ts`** — `isSafeReturnPath()` helper (exported for tests); oauth/start reads `req.body?.returnTo` → `state.r`; callback dest resolution per §4.3.

### CREATE — frontend (all styling on semantic tokens/primitives only; imports from the `shared/components` barrel in-package)
8. **`modules/library/components/LibraryRoutes.tsx`**
```tsx
export function LibraryRoutes() {
  return (
    <Routes>
      <Route index element={<LibraryPage />} />
      <Route path="tools/:slug" element={<ToolPage />} />
      {/* ROUTE CONTRACT — Ali: add <Route path="skills/:name" element={<SkillPage />} /> here */}
      <Route path="*" element={<Navigate to="/skills-and-tools" replace />} />
    </Routes>
  );
}
```
9. **`modules/library/components/tool-page/ToolPage.tsx`** — `export function ToolPage()` (no props; `useParams<{slug: string}>()`). Owns: `useToolPage(slug)`, OAuth fragment state (`useState(readOAuthFragment)` + strip effect), `actionError` state, share-panel open state, header/back/kicker/lede, `ToolConnectionSection`, capabilities section, powered-skills section, ownerline, `ToolSharePanel`, and the loading/error/not-found states. Uses `useAdmin().isAdmin` for the Manage access button. Internal (non-exported) subcomponents `SectionHeading({children, trailing?})`, `CapabilitiesSection`, `PoweredSkillsSection` are fine.
10. **`modules/library/components/tool-page/ToolConnectionSection.tsx`**
```ts
export interface ToolConnectionSectionProps {
  tool: ToolSecrets;
  onChanged(): void;
  onError(message: string): void;
}
export function ToolConnectionSection(props: ToolConnectionSectionProps)
```
Renders heading + Open Secrets link, setup banner (per §2.1(3), using `useWorkspace().kbDirName`, `kbFileUrl`, `DEFAULT_BRANCH` from `@bevel-software/platform-shared`), rows via `ToolVarRow`, or `Nothing to set up`.
11. **`modules/library/components/tool-page/ToolVarRow.tsx`**
```ts
export interface ToolVarRowProps {
  slug: string;
  variable: ToolVarStatus;          // from tool-secrets.api.ts
  canWrite: boolean;
  setupKind: 'open' | 'oauth-auto' | 'oauth-manual' | null;
  returnTo: string;                 // `/skills-and-tools/tools/${slug}`
  onChanged(): void;
  onError(message: string): void;
}
export function ToolVarRow(props: ToolVarRowProps)
```
Implements the full matrix + inline editors from §2.1. OAuth start imports `startToolOAuth` from `modules/secrets-vault/services/connect.api.ts` (**not** tool-secrets.api.ts — known gotcha); writes go through `setAdminVar`/`setUserVar`/`deleteAdminVar`/`setOAuthClientSecret` from `tool-secrets.api.ts`.
12. **`modules/library/components/tool-page/ToolSharePanel.tsx`** — per §2.3:
```ts
export interface ToolSharePanelProps { open: boolean; tool: { slug: string; name: string; path: string }; onClose(): void }
export function ToolSharePanel(props: ToolSharePanelProps)
```
13. **`modules/library/utils/oauth-fragment.ts`**
```ts
export type OAuthFragmentOutcome = { kind: 'authorized' } | { kind: 'error'; message: string } | null;
export function readOAuthFragment(): OAuthFragmentOutcome
```
(Same semantics as SecretsPage's private `readHashOutcome`; SecretsPage is NOT refactored to use it — zero churn on Ali-adjacent files.)
14. **`modules/library/hooks/useToolPage.ts`** — per §4.6.
15. **`modules/library/services/tools.api.ts`** — per §4.6, using `authFetch` from `lib/api` and the same `unwrap` error convention (`body.error` or fallback).
16. **Test files** — see §7: `modules/library/__tests__/ToolPage.test.tsx`, `ToolVarRow.test.tsx`, `ToolConnectionSection.test.tsx`, `ToolSharePanel.test.tsx`, `LibraryRoutes.test.tsx`, `oauth-fragment.test.ts`, `useToolPage.test.tsx`.

### MODIFY — frontend
17. **`core/CoreAppShell.tsx`** — `CORE_APPS` entry `skills-tools`: `element: <LibraryRoutes />` (import swap). Nothing else.
18. **`modules/library/components/LibraryPage.tsx`** — integration card click: `navigate(`/skills-and-tools/tools/${encodeURIComponent(item.id)}`)`; remove construction of `{kind:'integration'}` detail targets. Skill cards unchanged.
19. **`modules/library/components/DetailDialog.tsx`** — **extract/delete the tool half only**: remove `ToolDetailBody`, `ToolBodyProps`, and the `target.kind === 'integration'` branch; narrow `DetailTarget` to `{ kind: 'skill'; skill: LibrarySkillSummary; owned: boolean }`. **Keep** `IntItem`, `ConnectButton`, `StatusDot` usage, `OWNER_TAG`, `touchesSkill`, and the entire skill half untouched (shared with Ali; `IntItem`/`ConnectButton` are used by `SkillDetailBody`). `DetailDialogProps` keeps `tools`, `crs`, `myCrNumbers`, `onDataChanged` (skill half uses them).
20. **`modules/library/__tests__/DetailDialog.test.tsx`** — drop tool-half cases; keep skill cases green.
21. **`core/__tests__/ShellRoutes.test.tsx`** — keep the existing `/skills-and-tools` assertion passing (now via LibraryRoutes); add a case that `/skills-and-tools/tools/some_tool` renders the tool page surface (assert on the `Loading…` text or a mocked page marker).
22. **`modules/secrets-vault/services/connect.api.ts`** — `startToolOAuth` optional `opts` per §4.3.
23. **`modules/secrets-vault/components/SecretsPage.tsx`** — line 140 span → `Link` per §2.4 (import `Link` from react-router-dom). No other change; fragment logic untouched.
24. **`modules/secrets-vault/components/ConnectToolsPage.tsx`** — tool names → `Link`s per §2.4. Agent-mode logic, sessionStorage, Finish flow, destructive-untick, empty-pending-success branch all untouched.
25. **`modules/secrets-vault/components/__tests__/SecretsPage.test.tsx`** — add one assertion: tool name renders as a link with `aria-label="Open {name}"` pointing at the tool route.

### DELETE
None. (The tool half of DetailDialog is removed in-place; no files are deleted.)

---

## 6. Milestones (dependency order; each independently shippable + verifiable)

**M1 — Backend: tool detail endpoint.** Items 1, 3–6. Ships dark (no consumer). Verify: `pnpm -C packages/core-backend test` green; manual `curl -H "Authorization: Bearer …" /api/tools/<slug>` returns description/capabilities; unauthenticated 401; unreadable slug 404.

**M2 — Backend: OAuth `returnTo`.** Items 2, 7. Backward compatible (no body → exact current behavior; `/connect` unaffected). Verify: backend tests green incl. legacy-state case; existing secrets-vault route tests untouched and green.

**M3 — Routed page skeleton + dialog extraction.** Items 8, 9 (read-only version: header, chips-only connection rows, not-found/loading/error), 13, 14, 15, 17, 18, 19, 20, 21, plus `LibraryRoutes.test.tsx`, `oauth-fragment.test.ts`, `useToolPage.test.tsx`, first `ToolPage.test.tsx` cases. After M3 the dialog tool-half is gone and every integration card deep-links. Depends on M1 only softly (detail degrades to null against an older backend). Verify: `pnpm -C packages/core-frontend test`, `pnpm ds:check` (no baseline increase), manual: card click → URL changes, refresh deep-link works, legacy `Tools/x.tool` shows kicker `Tool`.

**M4 — Interactive connection.** Items 10, 11, 22 + ToolPage wiring of `ToolConnectionSection`, fragment banner, action errors; tests `ToolVarRow.test.tsx`, `ToolConnectionSection.test.tsx`, remaining `ToolPage.test.tsx` OAuth cases. Depends on M2 for the round-trip landing back on the page (against an M2-less backend the flow still works but lands on `/connect` — do not ship M4 before M2). Verify: frontend tests; manual OAuth loop against a dev provider lands on `/skills-and-tools/tools/:slug#authorized` → banner `Signed in to {name}.`; admin set/replace/remove round-trips reflected in chips.

**M5 — Share stub + cross-surface deep links.** Items 12, 23, 24, 25 + `ToolSharePanel.test.tsx` + Manage-access wiring in ToolPage. No backend dependency. Verify: frontend tests; `/secrets` and `/connect` tool names navigate to the page; Manage access visible only when `useAdmin().isAdmin`.

---

## 7. Test plan

All frontend tests: vitest + happy-dom + @testing-library/react, in `packages/core-frontend/src/modules/library/__tests__/` (module convention), selecting **only** by role / accessible name / aria-label / title / text (frozen a11y contract). Router via `MemoryRouter`. `startToolOAuth`, `tool-secrets.api`, `library.api`, `tools.api` mocked with `vi.mock`; never assign `window.location.href` in tests (assert the mocked `startToolOAuth` call + returned-URL handling via a spy).

**`ToolPage.test.tsx`**
- `renders loading then header, kicker with group, lede and ownerline` (tool at `Groups/GTM/heyreach.tool` → kicker `Tool · GTM`).
- `renders kicker without group for legacy ungrouped path` (`Tools/slack.tool` → exactly `Tool`).
- `shows not-found copy when slug is not in listToolSecrets response`.
- `shows error banner with Try again when listToolSecrets rejects; Try again refetches`.
- `hides lede and capabilities when getToolDetail rejects (degraded)`.
- `renders capabilities bullets from detail.capabilities`.
- `renders powered-skills chips linking to /skills-and-tools/skills/:name` (mock skills + allowedTools; assert link hrefs).
- `renders "No skills use this yet." only after skills load with no match`.
- `renders "Nothing to set up" when variables is empty`.
- `Manage access button visible for admin, absent for non-admin` (mock AdminProvider context).
- `Manage access opens dialog titled "Share tool"`.
- `#authorized fragment shows "Signed in to {name}." status banner and strips the hash once`.
- `#error=… fragment shows alert banner with decoded message (no double decode: message containing %20 stays literal)`.

**`ToolVarRow.test.tsx`** (drives the full matrix)
- admin+configured non-writer → badge `Set by an Admin`, no buttons.
- admin+configured writer → `Replace` and `Remove` buttons; `Remove` calls `deleteAdminVar` then `onChanged`.
- admin+unset non-writer → badge `Not set`; writer → `Set key` opens editor; `Save` disabled when empty; save calls `setAdminVar(slug, name, value)` then closes and `onChanged`.
- user non-oauth configured → badge `Connected`; unconfigured → `Add key` → editor → `setUserVar`.
- oauth authorized → badge `Connected`; `needsReauth` → button `Sign in again`.
- oauth unauthorized adminConfigured → `Sign in` calls `startToolOAuth(slug, name, {returnTo:'/skills-and-tools/tools/'+slug})`.
- oauth unauthorized !adminConfigured non-writer → badge `Not set` + sub-copy `The tool owner hasn't finished the sign-in setup yet.`; writer → `Set client secret` editor → `setOAuthClientSecret`.
- `setupKind 'oauth-auto' never renders any client-secret affordance even for writers`.
- `API rejection surfaces via onError(message)`.

**`ToolConnectionSection.test.tsx`**
- heading `Your connection` + `Open Secrets` link href `/secrets`.
- oauth-manual + unconfigured + canWrite → wait banner with `Edit the tool file` (kbDirName mocked truthy); non-writer → owner-ask copy, no edit link; kbDirName null → no edit link.
- setup open/oauth-auto/null → no banner.
- rows render in server order.

**`ToolSharePanel.test.tsx`**
- `open renders Dialog with title "Share tool", body copy with tool name, and the seam placeholder (data-testid tool-share-panel-body)`.
- `Done calls onClose`; `closed renders nothing`.

**`LibraryRoutes.test.tsx`**
- index renders LibraryPage; `tools/:slug` renders ToolPage; unknown subpath redirects to `/skills-and-tools`.

**`oauth-fragment.test.ts`**
- parses `#authorized`, `#authorized=abc`, `#error=Something%20bad` (single decode), returns null on empty/no hash.

**`useToolPage.test.tsx`** (renderHook)
- resolves tool by slug; notFound when absent; error only on listToolSecrets rejection; detail/skills degrade to null/[] silently; stale response from an earlier reload is discarded (monotonic ref).

**Modified suites:** `DetailDialog.test.tsx` (tool cases removed, skill cases untouched/green), `ShellRoutes.test.tsx` (+ tool route case), `SecretsPage.test.tsx` (+ `Open {name}` link case).

**Backend — `modules/tool-manuals/__tests__/tool-manuals.detail.route.test.ts`** (express app with stub service, mirroring existing route tests)
- 200 with description + capabilities for an accessible inline tool.
- capabilities `[]` for mcp/http descriptor; malformed `tools` entries skipped; cap at 100.
- 404 unknown slug; 404 for tool the caller cannot read (getDetail null); 401 without email.
- `normalizeToolManual` (extend `tool-manuals.service.test.ts`): string description trimmed onto descriptor; non-string description ignored without skipping the file.

**Backend — `modules/secrets-vault/__tests__/oauth-return-to.route.test.ts`**
- start with valid `returnTo` signs state whose `r` equals the path (decode/verify with test stateSecret).
- start with no body / invalid returnTo (`//evil`, `https://evil`, contains `#`, backslash, >512 chars) → `r:'connect'`.
- callback with `r:'/skills-and-tools/tools/github'` → 302 to `${publicFrontendUrl}/skills-and-tools/tools/github#authorized=…`.
- callback with legacy `r:'connect'` → `/connect#…`; with `r` undefined → `/secrets#…`; with a tampered/unsafe `r` that somehow fails re-validation → falls back to `/secrets`.
- error path: completeOAuth throw → `#error=<msg>` on the resolved dest.
- `isSafeReturnPath` unit table.

---

## 8. Edge cases + failure modes

- **Loading:** single `Loading…` line; no layout skeleton needed. Powered-skills never flashes its empty state before `skillsLoaded`.
- **403 / unreadable tool:** `GET /api/secrets/tools` simply omits it → Not-found state (fail-closed, indistinguishable from nonexistence — deliberate). Admin-write routes returning 403 (race: access revoked after page load) → error banner with server message; chips refresh on next `onChanged`.
- **Empty variables** (`setup.kind==='open'` mcp tools, or credential-less tools): `Nothing to set up`; the rest of the page still renders.
- **Unmigrated KB with legacy roots:** `groupOfPath` accepts `Groups/`, `Skills/`, `Tools/` roots. `Tools/GTM/x.tool` → group `GTM` (works pre-KB-PR-#8); `Tools/x.tool` (2 segments) → `null` → kicker `Tool`. The page never assumes a `Groups/` prefix; nothing breaks before or after PR #8 merges.
- **Tool with no group:** kicker `Tool`, everything else normal (also covers the post-migration ungrouped case).
- **Detail endpoint missing/failed** (old backend, network): `detail = null` → no lede, no capabilities section; connection + skills still fully functional. This is what makes M3 shippable before M1 is deployed.
- **OAuth round-trip:** provider redirects to backend callback → 302 to `${publicFrontendUrl}/skills-and-tools/tools/:slug#authorized|#error`. Page parses once synchronously (initializer), strips with `replaceState(pathname)`. Expired state (10-min HMAC window) arrives as `#error=OAuth state mismatch` → alert banner. If M4 frontend runs against an M2-less backend, the flow lands on `/connect#authorized` — degraded but correct.
- **oauth-auto:** synthetic `MCP_OAUTH` var carries no scopes → never `needsReauth`; no client-secret UI ever (would clobber the discovered PKCE client).
- **409 from oauth/start** ("This tool's owner hasn't finished setting this up") → error banner verbatim from server.
- **needsReauth / wiped tokens** (definitive refresh failure server-side): row shows `Sign in` / `Sign in again`; no special handling needed.
- **Slug edge:** slugs match `/^[a-z0-9][a-z0-9_]*$/`; links still `encodeURIComponent` everywhere. Duplicate-name tools are refused server-side (keep-first) — the page can only ever see one.
- **Logged out deep link:** `AuthGate` handles before the page mounts.
- **kbDirName null** (workspace context not ready): "Edit the tool file" link simply not rendered.
- **Secret handling:** inputs are `type="password"`, state-local, cleared on save/cancel; no value is ever fetched, logged, or echoed; only PUT bodies to existing endpoints.
- **Concurrent edits with Ali:** only deletions inside `DetailDialog.tsx` (tool half) and one `CORE_APPS` line touch shared surfaces; skill half, `modules/pr/`, `modules/review/` untouched.

---

## 9. Acceptance criteria checklist

1. [ ] `/skills-and-tools/tools/:slug` renders the tool page for any accessible tool; refresh/deep-link works; unknown/unreadable slug shows the not-found copy.
2. [ ] Library integration cards navigate to the route; `DetailDialog` no longer contains `ToolDetailBody` or an integration branch; skill half + `IntItem`/`ConnectButton` intact; skill dialog tests green.
3. [ ] Section order and copy match §2 verbatim: back `‹ All skills & tools`; kicker `Tool · {group}` / `Tool`; headings `Your connection`, `What it lets the assistant do`, `Powers these skills`; chips `Set by an Admin` / `Not set` / `Connected`; buttons `Sign in` / `Sign in again` / `Add key` / `Set key` / `Replace` / `Remove` / `Set client secret` / `Replace client secret`; empty states `Nothing to set up`, `No skills use this yet.`; ownerline `Managed by the Admins.`.
4. [ ] Per-variable state matrix implemented exactly (incl. oauth `adminConfigured` overload, oauth-auto client-secret suppression, disabled-sign-in sub-copy).
5. [ ] Owner (`canWrite`) admin-secret editing works end-to-end against existing endpoints; non-writers see chips only; no secret value is ever rendered.
6. [ ] OAuth sign-in from the page round-trips back to the page: `returnTo` signed into state, callback redirects to the path, `#authorized`/`#error` parsed once and stripped; legacy no-body starts still land on `/connect`; open-redirect-safe validation on start AND callback.
7. [ ] `GET /api/tools/:slug` live: JWT-gated, read-access fail-closed 404, description + capabilities correct; `description` frontmatter parsed tolerantly.
8. [ ] "Powers these skills" reverse index via `neededToolsFor` with chips linking to `/skills-and-tools/skills/:name` (route contract flagged for Ali in `LibraryRoutes.tsx`).
9. [ ] `ToolSharePanel` stub ships with the documented seam (path, props, `data-testid="tool-share-panel-body"`, title `Share tool`); Manage access visible to admins only.
10. [ ] Deep links live: `/secrets` and `/connect` tool names → tool page (`aria-label="Open {name}"`); tool page → `/secrets` via `Open Secrets`. `/connect` and `/secrets` paths and OAuth/agent-mode behavior otherwise byte-identical.
11. [ ] All new components have tests per §7; suites select by role/aria-label/title/text only; `pnpm -C packages/core-frontend test` and `pnpm -C packages/core-backend test` green.
12. [ ] `pnpm ds:check` passes with zero baseline increase: no slate, no raw hex classes, no `text-[Npx]`, no bare `rounded`; only barrel primitives + semantic tokens in new files; `cn()` (never raw twMerge) for class composition.

---

## 10. Open risks & fallbacks

- **`OAuthState.r` reuse conflicts with an unseen consumer.** `r` is currently only ever `'connect'`. If any other producer/consumer of `r` turns up during implementation, add a new field `rt` to `OAuthState` instead and leave `r` untouched — the design is otherwise identical.
- **`GET /tools/:slug` shadowing.** If Express route registration order in `createToolManualsBrowserRoutes` ever grows a literal sibling (e.g. `GET /tools/preview`), register literals before the param route. Today `preview` is POST-only — no conflict.
- **Ali's skill route lands with a different shape.** Chips link to `/skills-and-tools/skills/:name`; until then the catch-all redirects to the gallery. If Ali needs a different param (e.g. path-based), only the chip `to=` in `ToolPage.tsx` and one test change — isolated by design. The `LibraryRoutes.tsx` comment is the coordination point.
- **`ConnectToolsPage` name-markup assumptions.** The exact JSX around pending tool names wasn't fully read; if names render inside a control where a `Link` nests illegally, place the link as a sibling `Open` affordance with the same `aria-label` instead. The contract is the aria-label + destination, not the markup.
- **N+1 `getSkill` cost on every tool-page mount.** Accepted (matches gallery behavior; no bulk endpoint). If it becomes noticeable, add `GET /api/skills?include=allowedTools` later — out of scope, nothing here blocks it.
- **`useToolPage` vs a future shared cache.** If bucket G later wants shared library data, `useToolPage` is a thin orchestrator over the same service functions — it can be reimplemented over a cache without touching `ToolPage`'s render contract.
- **happy-dom + `window.location.href` assignment** in the sign-in path: keep the assignment behind a small `navigateExternal(url)` helper inside `ToolVarRow` so tests can spy it; if happy-dom still complains, mock the module.
- **Prototype copy deviations** (pinned back label; "— already handled" dropped when unset; owner inline editing on-page instead of Secrets-only; Sign in again label): all flagged above as deliberate. If review insists on strict prototype fidelity, each is a one-string/one-branch revert with a named test to update.
