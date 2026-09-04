import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { X, Lock, Loader2, ChevronDown, Check, Globe } from 'lucide-react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import {
  Badge,
  Banner,
  Button,
  Dialog,
  MenuItem,
  MenuPanel,
  useDismissableMenu,
  useModalLayer,
} from '../../../shared/components';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useAuth } from '../../auth/state/auth.context';
import {
  fetchFileAccess,
  grantAccess,
  revokeAccess,
  suggestPrincipals,
  asInheritedError,
  type AccessEligible,
  type AccessResponse,
  type GrantVerb,
  type GrantSource,
  type GrantSources,
  type Principal,
  type SuggestResponse,
} from '../api';
import { EMAIL_RE } from '../../../lib/email';

interface Props {
  entry: FileTreeEntry;
  onClose: () => void;
  /**
   * The workspace (branch) whose access is read and edited. Defaults to the
   * ambient `WorkspaceContext` — which is what the file explorer wants, since
   * it edits the branch the user is looking at.
   *
   * The Library is the other case: its surfaces describe the DEFAULT branch
   * regardless of which branch happens to be open, so a Library item's access
   * edit has to be pinned to it. Without this the same click would splice
   * `access.md` on whatever branch the context last had open — a rule written
   * into a draft nobody merges, silently doing nothing.
   */
  workspaceId?: string;
  /**
   * Retarget the sheet at an ancestor folder — the prototype's
   * `Manage <Folder> →` (proto:3647).
   *
   * The dialog cannot do this itself: it takes a fixed `entry`, and the caller
   * owns the state that chooses it. Every existing call site already holds
   * exactly that state, so wiring it is one line each. Omitted ⇒ the link does
   * not render, and an inherited grant stays read-only — which is the honest
   * fallback, not a silent no-op.
   */
  onManageAncestor?: (entry: FileTreeEntry) => void;
}

type Role = 'Owner' | 'Can edit' | 'Can read' | 'Can download';

/** Which verbs a principal holds at the target (independent flags). */
interface VerbSet {
  owner: boolean;
  write: boolean;
  read: boolean;
  download: boolean;
}

interface PrincipalRow {
  key: string;
  label: string;
  sub?: string;
  verbs: VerbSet;
  /**
   * What the row is: a person, a ROLE (app-defined capability), or a GROUP
   * (grant audience). Decides the badge ("Role" vs "Group") and which
   * principal kind mutations round-trip with.
   */
  kind: 'user' | 'role' | 'group';
  isYou: boolean;
  /** The principal to send on grant / revoke. */
  principal: Principal;
  /** Per-verb origin of this row's access (from the resolver). */
  sources?: GrantSources;
  /**
   * How this row may be managed HERE, derived from `sources` (now MECE —
   * every source is `direct` or `ancestor`):
   *   - 'direct'    — ≥1 verb is granted directly on the target; the verb
   *                   editor is shown and Remove acts in place.
   *   - 'inherited' — ≥1 verb comes from an ancestor folder (and none direct);
   *                   Remove opens the "Remove from parent?" flow.
   *   - 'external'  — no file-backed source for any verb (a defensive fallback;
   *                   a real grantee row always resolves to direct/ancestor,
   *                   since rows are built from file-named principals). Shown
   *                   read-only with no Remove.
   */
  manage: 'direct' | 'inherited' | 'external';
  /** The distinct ancestor access.md path(s) this row inherits any verb from. */
  ancestors: string[];
}

/**
 * Classify a row's manageability from its per-verb sources (now MECE — every
 * source is `direct` or `ancestor`):
 *   - any `direct` verb        → 'direct' (editable in place).
 *   - else any `ancestor` verb → 'inherited' (remove-from-parent / deny-here).
 *   - else (no source for any verb) → 'external' (defensive fallback; a real
 *     grantee row always has a file source, since rows are built from
 *     file-named principals).
 */
function classifyManage(sources: GrantSources | undefined): {
  manage: 'direct' | 'inherited' | 'external';
  ancestors: string[];
} {
  const lists = sources ? Object.values(sources).filter((l): l is GrantSource[] => !!l) : [];
  // A row is 'direct' (editable in place) when ANY verb's WINNING source (the
  // closest, `[0]`) is direct — even if that same verb is ALSO inherited from a
  // parent (`[direct, ancestor]`); the inherited tail still feeds `ancestors`
  // below, so Remove can chain to the parent after stripping the direct entry.
  const hasDirectWinner = lists.some((l) => l[0]?.kind === 'direct');
  // Every ancestor named for any verb (including the tails of direct+ancestor
  // verbs), so the confirm flow knows all the parents to offer.
  const ancestors = [
    ...new Set(lists.flatMap((l) => l.filter((s) => s.kind === 'ancestor').map((s) => (s as { path: string }).path))),
  ];
  if (hasDirectWinner) return { manage: 'direct', ancestors };
  if (ancestors.length > 0) return { manage: 'inherited', ancestors };
  return { manage: 'external', ancestors: [] };
}

/**
 * A short, human folder label for an ancestor `access.md` path. Renders the
 * LEAF folder only (the deepest segment) so long chains don't overflow the row;
 * the full repo-relative path is exposed separately as a hover title.
 */
function folderLabel(accessMdPath: string): string {
  const dir = accessMdPath.replace(/\/?access\.md$/, '');
  if (dir === '') return 'the root folder';
  const segs = dir.split('/');
  return segs[segs.length - 1];
}

/** The full folder path (for a hover title), repo-relative. */
function folderPath(accessMdPath: string): string {
  const dir = accessMdPath.replace(/\/?access\.md$/, '');
  return dir === '' ? 'the root folder' : dir;
}

/**
 * A principal's row/chip identity. Kind is PART of it: a group and a role
 * sharing a name are DIFFERENT principals server-side (bare token vs
 * `role/<name>`), so they key — and chip — separately (`g:` vs `r:`). One
 * name picked as both is two chips, and each grants its own kind.
 */
function principalKey(p: Principal): string {
  return p.kind === 'role'
    ? `r:${p.role.toLowerCase()}`
    : p.kind === 'group'
      ? `g:${p.group.toLowerCase()}`
      : `u:${p.email.toLowerCase()}`;
}

/**
 * Look a row/principal key up in a response's `sources` map. Group rows key
 * as `g:<name>`; an older server still keys groups under `r:<name>`, so a
 * miss on `g:` falls back to the shared legacy key (version skew only — a
 * current server emits `g:` for groups).
 */
function lookupSources(
  sources: AccessResponse['sources'] | undefined,
  key: string,
): GrantSources | undefined {
  return sources?.[key] ?? (key.startsWith('g:') ? sources?.[`r:${key.slice(2)}`] : undefined);
}

/** The distinct ancestor `access.md` path(s) named across a per-verb sources map. */
function ancestorsFromSources(sources: GrantSources | undefined): string[] {
  if (!sources) return [];
  return [
    ...new Set(
      Object.values(sources)
        .filter((l): l is GrantSource[] => !!l)
        .flatMap((l) => l.filter((s) => s.kind === 'ancestor').map((s) => (s as { path: string }).path)),
    ),
  ];
}

/** The checklist order; download is independent and rendered separately. */
const TIER_ROLES: Role[] = ['Owner', 'Can edit', 'Can read'];

/**
 * Muted identity tones (bg/fg pairs) — the same family as the Library's
 * monogram marks, so a person's avatar and a tool's logo read as one system
 * instead of one calm grid with saturated Drive-style discs in the middle.
 */
const AVATAR_TONES = [
  { bg: '#eaf1ea', fg: '#4f7a52' },
  { bg: '#e9eefb', fg: '#4560a8' },
  { bg: '#fbeeea', fg: '#a85a41' },
  { bg: '#f2eafa', fg: '#6f4a9b' },
  { bg: '#e7f2f4', fg: '#3d7783' },
  { bg: '#faf0e2', fg: '#8a6a2f' },
];

function initials(label: string): string {
  const parts = label.replace(/[<>]/g, '').trim().split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatarTone(seed: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_TONES[Math.abs(h) % AVATAR_TONES.length];
}

/** Human noun for a verb, used in the verb-scoped confirmation copy. */
const VERB_NOUN: Record<GrantVerb, string> = {
  owner: 'owner',
  write: 'edit',
  read: 'read',
  download: 'download',
};

/** The verb each UI role maps to when granting. */
const ROLE_TO_VERB: Record<Role, GrantVerb> = {
  Owner: 'owner',
  'Can edit': 'write',
  'Can read': 'read',
  'Can download': 'download',
};

/** The VerbSet key each UI role reads/writes. */
const ROLE_TO_KEY: Record<Role, keyof VerbSet> = {
  Owner: 'owner',
  'Can edit': 'write',
  'Can read': 'read',
  'Can download': 'download',
};

/** The built-in `everyone` role — grantable as public READ only (see backend). */
function isEveryoneRole(p: Principal): boolean {
  return p.kind === 'role' && p.role.trim().toLowerCase() === 'everyone';
}

/** A short summary of the verbs a row holds, for the dropdown trigger. */
function summarizeVerbs(v: VerbSet): string {
  const parts: string[] = [];
  if (v.owner) parts.push('Owner');
  else if (v.write) parts.push('Can edit');
  else if (v.read) parts.push('Can read');
  if (v.download) parts.push('Can download');
  return parts.length ? parts.join(', ') : 'No access';
}

/** Gap between a trigger and its menu, and the minimum inset from a viewport edge. */
const MENU_GAP = 4;
const MENU_MARGIN = 8;
/**
 * `MenuPanel`'s own `min-w-[200px]`. We position a box and the panel renders
 * inside it, so the two must agree: a narrower requested width would place a
 * 192px box that paints 200px wide, and a right-aligned menu would overhang its
 * trigger by the difference.
 */
const MENU_MIN_WIDTH = 200;

/**
 * A dropdown panel that escapes the dialog's scroll container.
 *
 * `Dialog` renders its body inside `overflow-y-auto` so a long access list
 * scrolls under the pinned header and footer. An ABSOLUTELY positioned menu in
 * that box is clipped by it: open the verb menu on a low grantee row and
 * everything past the first item or two — "Remove access" included — is cut off
 * at the body's edge, unreachable without scrolling the list out from under the
 * menu.
 *
 * `position: fixed` is the fix, because an overflow ancestor doesn't clip a
 * descendant whose containing block is the viewport. Deliberately NOT a portal:
 * the panel stays inside `Dialog`'s focus trap, which queries its own subtree,
 * so the items remain Tab-reachable. Being fixed, it has to be re-anchored to
 * the trigger's measured rect on scroll and resize — the same shape
 * `BranchSwitcher` uses for its portaled menu — and, because both boxes can
 * change size with the menu still open, whenever either one is resized.
 *
 * The anchor is the panel's own DOM PARENT — i.e. render this where the
 * `absolute` panel used to sit, and it lines up against the same box `absolute`
 * measured. That's not just brevity: a ref passed down from the parent is NOT
 * attached yet when this component's layout effect runs (React attaches refs
 * bottom-up, children first), so the first placement would silently no-op and
 * the panel would stay hidden.
 *
 * Dismissal is the caller's to opt into with `onDismiss`. A menu whose open
 * state is a boolean the caller owns (the verb checklists) has to close on an
 * outside click and on Escape, or it sits open until something inside it is
 * picked — a trap for anyone driving the app from the keyboard, and a surprise
 * for everyone else. That is `useDismissableMenu`'s job, plus one thing the
 * hook's own docstring warns it does NOT do: co-exist with the `Dialog` this
 * menu lives in, which also listens for Escape on `document` and would close
 * itself on the same keypress. Registering the open menu as a modal layer
 * makes it the topmost, so `Dialog` stands down until the menu is gone. The
 * suggestion list leaves `onDismiss` unset: its openness is derived from what
 * is typed, not from a flag a click could clear.
 */
function AnchoredMenu({
  /**
   * Close the menu. Called on a mousedown outside the panel and its trigger,
   * and on Escape (which also hands focus back to the trigger). Leave unset
   * for a panel whose visibility is not an open flag.
   */
  onDismiss,
  /**
   * Panel width in px, or `'anchor'` to match the trigger (the combobox case).
   * Clamped up to {@link MENU_MIN_WIDTH} either way.
   */
  width = MENU_MIN_WIDTH,
  /** Which edge lines up with the anchor's. */
  align = 'right',
  className = '',
  children,
}: {
  onDismiss?: () => void;
  width?: number | 'anchor';
  align?: 'left' | 'right';
  className?: string;
  children: ReactNode;
}) {
  // The control that opened us: the anchor's button. Clicks on it are the
  // trigger's own business (its handler toggles), and Escape returns focus to
  // it. Resolved in the layout effect below, once the panel is in the DOM.
  const triggerRef = useRef<HTMLElement | null>(null);
  const dismissable = onDismiss !== undefined;
  // Callers pass a fresh `onDismiss` arrow each render, and the hook lists
  // `onClose` in its effect deps: handed the arrow directly it would tear down
  // and re-add its document listeners on every render of the open menu — each
  // verb toggled in the checklist included. Mirror the arrow into a ref (the
  // same shape `Dialog` uses for its `onClose`) and give the hook one stable
  // callback, so it subscribes once for the life of the open menu.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);
  const close = useCallback(() => onDismissRef.current?.(), []);
  const panelRef = useDismissableMenu<HTMLDivElement>({
    open: dismissable,
    onClose: close,
    returnFocusTo: triggerRef,
  });
  useModalLayer(dismissable);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchorEl = panel?.parentElement ?? null;
    triggerRef.current = anchorEl?.querySelector('button') ?? anchorEl;
    const place = () => {
      const el = panelRef.current;
      const anchor = el?.parentElement?.getBoundingClientRect();
      if (!anchor || !el) return;
      const w = Math.max(width === 'anchor' ? anchor.width : width, MENU_MIN_WIDTH);
      // Width BEFORE height: the panel wraps and grows taller when narrower, so
      // measuring at the wrong width picks the wrong side to open on.
      el.style.width = `${w}px`;
      const h = el.offsetHeight;
      const left = Math.max(
        MENU_MARGIN,
        Math.min(
          align === 'right' ? anchor.right - w : anchor.left,
          window.innerWidth - w - MENU_MARGIN,
        ),
      );
      // Below by default. Flip above only when the panel would run off the
      // bottom AND there is actually room up there — otherwise a tall menu on a
      // low trigger would just lose its top instead of its bottom.
      const below = anchor.bottom + MENU_GAP;
      const above = anchor.top - MENU_GAP - h;
      const top =
        below + h > window.innerHeight - MENU_MARGIN && above >= MENU_MARGIN ? above : below;
      // Keep the previous object when nothing moved. `place` runs on every
      // scroll frame and on every observed resize, and a fresh object each time
      // would re-render for nothing — and, since the panel is what's observed,
      // feed the observer its own output.
      setPos((prev) =>
        prev && prev.top === top && prev.left === left && prev.width === w
          ? prev
          : { top, left, width: w },
      );
    };
    place();
    // Both measured boxes move under us while the menu is open, and neither
    // move fires scroll or resize. The trigger relabels itself as verbs are
    // toggled ("Can edit" → "Owner, Can download"), which shifts `anchor.right`
    // out from under a right-aligned panel; the panel itself grows and shrinks
    // as the suggestion list follows what's typed, so one measured to fit below
    // ends up hanging off the bottom it was checked against.
    const observer = new ResizeObserver(place);
    if (anchorEl) observer.observe(anchorEl);
    if (panel) observer.observe(panel);
    window.addEventListener('resize', place);
    // Capture phase: the dialog body is what scrolls, and scroll events don't
    // bubble to `window`.
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [width, align, panelRef]);

  return (
    <div
      ref={panelRef}
      className="fixed z-[60]"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: pos?.width ?? (typeof width === 'number' ? width : undefined),
        // Covers the measuring pass only. `useLayoutEffect` places the panel
        // before the browser paints, so an unpositioned one is never on screen.
        visibility: pos ? undefined : 'hidden',
      }}
    >
      <MenuPanel className={`w-full ${className}`}>{children}</MenuPanel>
    </div>
  );
}

/**
 * Google-Drive-style "Manage access" sheet. Reads the resolved access for a KB
 * path and lets anyone who can write the path's access config share it: add one
 * or more people/groups/roles as chips and grant them a shared verb (Owner / Can edit /
 * Can read / Can download). Each existing grantee's verbs are editable inline via
 * a multi-select checklist (independent verbs); toggling a box grants or revokes
 * that single verb. Grants/revokes write the folder's `access.md` (folder target)
 * or the node's own frontmatter (file target) server-side and commit + push. When
 * the user can't write the access config, the add affordance is disabled and
 * names the owners to ask.
 */
export function ManageAccessDialog({
  entry,
  onClose,
  workspaceId: workspaceIdProp,
  onManageAncestor,
}: Props) {
  // `kbDirName` stays context-sourced: it names the clone directory, which is
  // the same on every branch.
  const { workspaceId: ctxWorkspaceId, kbDirName } = useWorkspace();
  const workspaceId = workspaceIdProp ?? ctxWorkspaceId;
  const { user } = useAuth();
  const [data, setData] = useState<AccessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-row state. `newVerbs` holds the (independent) verbs to grant the chips;
  // it mirrors the per-row checklist so a new person can be given several at once.
  const [query, setQuery] = useState('');
  const [newVerbs, setNewVerbs] = useState<VerbSet>({
    owner: false,
    write: true,
    read: false,
    download: false,
  });
  const [verbOpen, setVerbOpen] = useState(false);
  const [suggest, setSuggest] = useState<SuggestResponse | null>(null);
  const [pickedChips, setPickedChips] = useState<Principal[]>([]);
  const [busy, setBusy] = useState(false);
  const [mutateError, setMutateError] = useState<string | null>(null);
  // Which existing row's verb checklist is open (one at a time).
  const [openRowKey, setOpenRowKey] = useState<string | null>(null);
  // When set, the "Remove from parent?" confirmation is open for this principal.
  // `ancestors` are the granting access.md path(s) (repo-relative, opaque) to
  // echo back on remove-from-parent. `verb` scopes the action to a single verb
  // (set when the flow was triggered by unchecking ONE inherited verb); absent
  // ⇒ the whole principal (every verb), as for the row's Remove button.
  const [confirmRemove, setConfirmRemove] = useState<{
    principal: Principal;
    label: string;
    ancestors: string[];
    verb?: GrantVerb;
  } | null>(null);

  // Repo-relative path the access resolver expects (strip the `<kbDir>/`
  // prefix). `null` ⇒ the item isn't inside the KB, so it isn't governed.
  const repoRelative = useMemo(() => {
    if (!kbDirName) return null;
    if (entry.relativePath === kbDirName) return '';
    const prefix = `${kbDirName}/`;
    return entry.relativePath.startsWith(prefix) ? entry.relativePath.slice(prefix.length) : null;
  }, [entry.relativePath, kbDirName]);

  const targetKind: 'folder' | 'file' = entry.type === 'directory' ? 'folder' : 'file';

  const reload = useCallback(() => {
    if (repoRelative === null || !workspaceId) return;
    fetchFileAccess(workspaceId, repoRelative, targetKind)
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [workspaceId, repoRelative, targetKind]);

  useEffect(() => {
    if (repoRelative === null || !workspaceId) return;
    let cancelled = false;
    fetchFileAccess(workspaceId, repoRelative, targetKind)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, repoRelative, targetKind]);

  // Escape / backdrop / focus trapping all belong to the shared `Dialog` now —
  // including the layering that lets the nested "Remove from parent?" modal
  // take Escape without also closing this one.

  // Debounced autocomplete. People are withheld server-side until q ≥ 2 chars.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!workspaceId || repoRelative === null) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setSuggest(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      suggestPrincipals(workspaceId, q)
        .then(setSuggest)
        .catch(() => setSuggest(null));
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, workspaceId, repoRelative]);

  const myEmail = user?.email?.toLowerCase() ?? '';

  const principals = useMemo<PrincipalRow[]>(() => {
    if (!data) return [];
    // Aggregate the four resolver lists into ONE row per principal carrying its
    // independent verb set. Membership IS the displayed set — we do NOT subtract
    // the rollup. The resolver already folds owner⊇write⊇read on the lower lists,
    // so an owner legitimately shows owner+write+read checked; download is its own
    // axis (owner folds in, write does not), sourced from `downloaders`.
    const rows = new Map<string, PrincipalRow>();
    // Kinded collective list for one eligible set. Older servers omit
    // `principals` (version skew) — fall back to the name-only `roles`,
    // treating everything as a role (the pre-groups display).
    const collectivesOf = (list: AccessEligible): { name: string; kind: 'role' | 'group' }[] =>
      list.principals ?? list.roles.map((name) => ({ name, kind: 'role' as const }));
    const touchCollective = (c: { name: string; kind: 'role' | 'group' }): PrincipalRow => {
      // Rows are keyed by KIND + name (`g:`/`r:`) — the backend treats a bare
      // `Product` (group) and `role/Product` (role) as DIFFERENT principals,
      // so a group and a role sharing a name are two rows, each mutating its
      // own grant. Collapsing them to one row silently pointed every edit at
      // the group and hid the role's grant entirely.
      const key =
        c.kind === 'group' ? `g:${c.name.toLowerCase()}` : `r:${c.name.toLowerCase()}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          label: c.name,
          kind: c.kind,
          isYou: false,
          principal:
            c.kind === 'group' ? { kind: 'group', group: c.name } : { kind: 'role', role: c.name },
          verbs: { owner: false, write: false, read: false, download: false },
          manage: 'direct',
          ancestors: [],
        };
        rows.set(key, row);
      }
      return row;
    };
    const touchUser = (u: { name: string; email: string }): PrincipalRow => {
      const key = `u:${u.email.toLowerCase()}`;
      let row = rows.get(key);
      if (!row) {
        const label = u.name || u.email;
        row = {
          key,
          label,
          // Only a real display name earns the second line — a nameless user
          // would otherwise render the same email twice, burning a row of the
          // scarce width on a duplicate.
          sub: label.toLowerCase() === u.email.toLowerCase() ? undefined : u.email,
          kind: 'user',
          isYou: u.email.toLowerCase() === myEmail,
          principal: { kind: 'user', email: u.email, displayName: u.name || u.email },
          verbs: { owner: false, write: false, read: false, download: false },
          manage: 'direct',
          ancestors: [],
        };
        rows.set(key, row);
      }
      return row;
    };

    for (const c of collectivesOf(data.owners)) touchCollective(c).verbs.owner = true;
    for (const u of data.owners.users) touchUser(u).verbs.owner = true;
    for (const c of collectivesOf(data.eligible)) touchCollective(c).verbs.write = true;
    for (const u of data.eligible.users) touchUser(u).verbs.write = true;
    // Read membership is per-principal only for a restricted node. When
    // `restricted` is false, read is `everyone` and the reader lists are empty.
    if (data.readers.restricted) {
      for (const c of collectivesOf(data.readers)) touchCollective(c).verbs.read = true;
      for (const u of data.readers.users) touchUser(u).verbs.read = true;
    }
    for (const c of collectivesOf(data.downloaders)) touchCollective(c).verbs.download = true;
    for (const u of data.downloaders.users) touchUser(u).verbs.download = true;

    // Attach each row's per-verb source + manageability (direct / inherited /
    // external) from the resolver's `sources` map, keyed by the same row key
    // (with the `g:` → `r:` version-skew fallback for group rows).
    for (const row of rows.values()) {
      row.sources = lookupSources(data.sources, row.key);
      const { manage, ancestors } = classifyManage(row.sources);
      row.manage = manage;
      row.ancestors = ancestors;
    }

    return [...rows.values()];
  }, [data, myEmail]);

  // Split direct (granted here, editable) from inherited/external (granted at a
  // parent or via a role) so the main list stays clean and the rest collapses
  // into a hidden "Inherited access" section.
  const directRows = useMemo(() => principals.filter((p) => p.manage === 'direct'), [principals]);
  const inheritedRows = useMemo(
    () => principals.filter((p) => p.manage !== 'direct'),
    [principals],
  );

  /**
   * The inherited rows, ONE SECTION PER GRANTING FOLDER — the prototype's shape
   * (proto:3637-3649) and, more to the point, its reasoning:
   *
   *   "Inheritance, said as a sentence instead of labelled as a concept.
   *    'People invited to KnowledgeBase' needs no explaining — it names the
   *    folder, and the folder is both what it means and where it changes. One
   *    collapsed row per granting folder, because two folders granting
   *    different people is the normal case and merging them would hide which
   *    one to open."
   *
   * This used to be a single "Inherited access (N) — from parent folders &
   * roles" disclosure. That heading names the CONCEPT, which the reader either
   * already understands or is not helped by, and merging every ancestor into
   * one list threw away the only fact that makes an inherited grant
   * actionable: which folder to go and edit.
   *
   * A principal granted by two folders appears under BOTH, deliberately — that
   * is the truth, and it is exactly the case a merged list hides.
   *
   * Rows with no ancestor at all (a role that grants at the workspace level,
   * `manage: 'external'`) have no folder to file under, so they keep a group of
   * their own at the end rather than being dropped.
   */
  const inheritedByFolder = useMemo(() => {
    const byFolder = new Map<string, PrincipalRow[]>();
    const external: PrincipalRow[] = [];
    for (const row of inheritedRows) {
      if (row.ancestors.length === 0) {
        external.push(row);
        continue;
      }
      for (const a of row.ancestors) {
        const list = byFolder.get(a);
        if (list) list.push(row);
        else byFolder.set(a, [row]);
      }
    }
    // Deepest folder first: the nearest ancestor is the one most likely to be
    // the one you meant, and it is the one whose rule wins.
    const folders = [...byFolder.entries()].sort(
      (a, b) => b[0].split('/').length - a[0].split('/').length,
    );
    return { folders, external };
  }, [inheritedRows]);

  /** Which inherited-access section is expanded — a granting folder's path, or
   *  `'roles'`, or null. One at a time — as in the prototype, where
   *  `state.accOpen` holds a single value. */
  const [openSection, setOpenSection] = useState<string | null>(null);

  const governed = repoRelative !== null;
  // The dialog can mutate only if the current user can write this path's access
  // config — exactly what the backend gate enforces. `canWrite` on the path is
  // the same signal (folder access.md / node frontmatter both gate on write).
  const canManage = !!data?.canWrite;

  // Resolve the CURRENT typed query into a principal to append as a chip: an
  // exact group/role match or a free-typed email. (Suggestion clicks append
  // directly.) Group first — bare grant tokens resolve group-first, so a name
  // shared by both defaults to the audience concept; the role stays reachable
  // via its own suggestion row.
  const addPending: Principal | null = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const groupHit = suggest?.groups?.find((g) => g.toLowerCase() === q.toLowerCase());
    if (groupHit) return { kind: 'group', group: groupHit };
    const roleHit = suggest?.roles?.find((g) => g.toLowerCase() === q.toLowerCase());
    if (roleHit) return { kind: 'role', role: roleHit };
    if (EMAIL_RE.test(q)) return { kind: 'user', email: q, displayName: q.split('@')[0] };
    return null;
  }, [query, suggest]);

  const principalLabel = (p: Principal): string =>
    p.kind === 'role' ? p.role : p.kind === 'group' ? p.group : p.displayName || p.email;

  const addChip = useCallback((p: Principal) => {
    setPickedChips((chips) =>
      chips.some((c) => principalKey(c) === principalKey(p)) ? chips : [...chips, p],
    );
    setQuery('');
    setSuggest(null);
  }, []);

  const removeChip = useCallback((p: Principal) => {
    setPickedChips((chips) => chips.filter((c) => principalKey(c) !== principalKey(p)));
  }, []);

  // The new-grant checklist stores independent flags, but owner⊇write⊇read folds
  // for display (selecting Owner implies edit+read; Edit implies read; owner also
  // folds in download). `effectiveNewVerbs` is what the boxes render as checked.
  const effectiveNewVerbs = useMemo<VerbSet>(
    () => ({
      owner: newVerbs.owner,
      write: newVerbs.owner || newVerbs.write,
      read: newVerbs.owner || newVerbs.write || newVerbs.read,
      download: newVerbs.owner || newVerbs.download,
    }),
    [newVerbs],
  );

  // The minimal verb list to send: the single highest tier verb (the lower ones
  // fold in server-side) plus download when it's chosen independently of owner.
  const grantVerbs = useMemo<GrantVerb[]>(() => {
    const verbs: GrantVerb[] = [];
    if (effectiveNewVerbs.owner) verbs.push('owner');
    else if (effectiveNewVerbs.write) verbs.push('write');
    else if (effectiveNewVerbs.read) verbs.push('read');
    if (effectiveNewVerbs.download && !effectiveNewVerbs.owner) verbs.push('download');
    return verbs;
  }, [effectiveNewVerbs]);

  const doGrant = useCallback(async () => {
    if (!workspaceId || repoRelative === null || pickedChips.length === 0 || grantVerbs.length === 0)
      return;
    setBusy(true);
    setMutateError(null);
    // No batch grant endpoint exists, so apply each principal/verb pair and
    // collect failures rather than stopping on the first — one refused grant
    // must not silently skip the remaining pairs. Partial success is reported
    // after reload so the user sees exactly what didn't apply.
    const failures: string[] = [];
    try {
      for (const principal of pickedChips) {
        const label = principalLabel(principal);
        // `everyone` is public-read only — the backend rejects any other verb for
        // it, so clamp here to avoid a guaranteed failure when a higher verb is
        // also selected for the other chips.
        const verbsForPrincipal = isEveryoneRole(principal)
          ? (effectiveNewVerbs.read ? (['read'] as GrantVerb[]) : [])
          : grantVerbs;
        // Don't silently drop the Everyone chip when nothing read-equivalent was
        // picked (e.g. only "Can download"): record it as a failure so the chip
        // stays visible and the user is told why, rather than a no-op clear.
        if (isEveryoneRole(principal) && verbsForPrincipal.length === 0) {
          failures.push(`${label}: "Everyone" can only be granted read access. Select "Can read".`);
          continue;
        }
        for (const verb of verbsForPrincipal) {
          try {
            await grantAccess(workspaceId, {
              path: entry.relativePath,
              kind: targetKind,
              verb,
              principal,
            });
          } catch (err) {
            failures.push(`${label} (${verb}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      if (failures.length === 0) {
        setPickedChips([]);
        setQuery('');
        setSuggest(null);
      } else {
        setMutateError(
          `${failures.length} grant${failures.length === 1 ? '' : 's'} failed (the rest were applied):\n${failures.join('\n')}`,
        );
      }
    } finally {
      reload();
      setBusy(false);
    }
  }, [workspaceId, repoRelative, pickedChips, entry.relativePath, targetKind, grantVerbs, effectiveNewVerbs, reload]);

  // Revoke the public-read grant (`read: everyone`) at THIS path. Clears the
  // "Anyone can read" state when it was granted here; an inherited public grant
  // (from a parent folder) stays and is removed where it was set.
  const removePublicRead = useCallback(async () => {
    if (!workspaceId || repoRelative === null) return;
    setBusy(true);
    setMutateError(null);
    try {
      await revokeAccess(workspaceId, {
        path: entry.relativePath,
        kind: targetKind,
        principal: { kind: 'role', role: 'everyone' },
        verb: 'read',
      });
      reload();
    } catch (err) {
      // The public-read grant lives in a parent folder — route the 409 into the
      // same "Remove from parent? / Restrict here?" confirmation the grantee rows
      // use, instead of a raw error toast.
      const inherited = asInheritedError(err);
      if (inherited) {
        setConfirmRemove({
          principal: { kind: 'role', role: 'everyone' },
          label: 'Everyone',
          ancestors: ancestorsFromSources(inherited.sources),
          verb: 'read',
        });
      } else {
        setMutateError(err instanceof Error ? err.message : String(err));
        reload();
      }
    } finally {
      setBusy(false);
    }
  }, [workspaceId, repoRelative, entry.relativePath, targetKind, reload]);

  // Toggle a single verb on an existing grantee: check → grant that verb, uncheck
  // → revoke just that verb. The server's fresh view is authoritative (we never
  // flip optimistically); a refused revoke (e.g. lock contention) surfaces its
  // message and we re-sync.
  const doToggleVerb = useCallback(
    async (principal: Principal, role: Role, currentlyOn: boolean) => {
      if (!workspaceId || repoRelative === null) return;
      setBusy(true);
      setMutateError(null);
      try {
        const grantVerb = ROLE_TO_VERB[role];
        const res = currentlyOn
          ? await revokeAccess(workspaceId, {
              path: entry.relativePath,
              kind: targetKind,
              principal,
              verb: grantVerb,
            })
          : await grantAccess(workspaceId, {
              path: entry.relativePath,
              kind: targetKind,
              verb: grantVerb,
              principal,
            });
        setData(res);
        // When UNCHECKING, the direct entry for this verb was stripped (200) but
        // the principal may STILL hold the SAME verb via an ancestor — i.e. the
        // verb was `[direct, ancestor]`. The fresh view still lists them with the
        // ancestor for this verb; chain into the verb-scoped "Remove from parent?"
        // so one uncheck finishes the job instead of a half-removal (the direct
        // bit gone, the inherited bit silently remaining and the box re-checking).
        if (currentlyOn) {
          const key = principalKey(principal);
          const stillForVerb = lookupSources(res.sources, key)?.[grantVerb] ?? [];
          const ancestors = ancestorsFromSources({ [grantVerb]: stillForVerb });
          if (ancestors.length > 0) {
            setConfirmRemove({
              principal,
              label: principalLabel(principal),
              ancestors,
              verb: grantVerb,
            });
          }
        }
      } catch (err) {
        // Unchecking a verb the principal holds via INHERITANCE (e.g. they're
        // direct on `download` but inherit `write`) can't be done in place — the
        // target splice no-ops and the route 409s. Convert that into the same
        // "Remove from parent?" flow a Remove uses, instead of a raw error toast.
        const inherited = asInheritedError(err);
        if (inherited) {
          const label = principalLabel(principal);
          // Scope the confirmation to the single verb the user unchecked, so
          // "Restrict just this file" / "Remove from parent" act on THAT verb
          // only and leave the principal's other (e.g. direct download) verbs.
          setConfirmRemove({
            principal,
            label,
            ancestors: ancestorsFromSources(inherited.sources),
            verb: ROLE_TO_VERB[role],
          });
        } else {
          setMutateError(err instanceof Error ? err.message : String(err));
          reload(); // re-sync after a refused/rolled-back toggle
        }
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, repoRelative, entry.relativePath, targetKind, reload],
  );

  const doRevoke = useCallback(
    async (row: PrincipalRow) => {
      if (!workspaceId || repoRelative === null) return;
      // An inherited / external row can't be removed in place — open the
      // "Remove from parent?" flow instead of firing a revoke that 409s.
      if (row.manage !== 'direct') {
        setConfirmRemove({
          principal: row.principal,
          label: row.label,
          ancestors: row.ancestors,
        });
        return;
      }
      setBusy(true);
      setMutateError(null);
      try {
        const res = await revokeAccess(workspaceId, {
          path: entry.relativePath,
          kind: targetKind,
          principal: row.principal,
        });
        setData(res);
        // The direct entry was removed, but the FRESH view may still list this
        // principal with only `ancestor` source(s) — i.e. they're still inherited
        // from a parent. Open "Remove from parent?" so the one Remove click can
        // finish the job instead of leaving a row that reappears as inherited (a
        // silent half-removal). We read the just-revoked row's post-revoke sources
        // straight from the response, so it reflects the real current tree.
        const ancestors = ancestorsFromSources(lookupSources(res.sources, row.key));
        if (ancestors.length > 0) {
          setConfirmRemove({ principal: row.principal, label: row.label, ancestors });
        }
      } catch (err) {
        // Defensive: a revoke that 409s straight away (a row that was purely
        // inherited but somehow reached here) — fall back to the confirmation.
        const inherited = asInheritedError(err);
        if (inherited) {
          setConfirmRemove({
            principal: row.principal,
            label: row.label,
            ancestors: ancestorsFromSources(inherited.sources),
          });
        } else {
          setMutateError(err instanceof Error ? err.message : String(err));
          reload(); // re-sync the row state after a refused/rolled-back revoke
        }
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, repoRelative, entry.relativePath, targetKind, reload],
  );

  /** Cascade up: remove the principal from the granting ancestor folder (optionally scoped to one verb). */
  const doRemoveFromParent = useCallback(
    async (principal: Principal, ancestorAccessMd: string, verb?: GrantVerb) => {
      if (!workspaceId || repoRelative === null) return;
      setBusy(true);
      setMutateError(null);
      try {
        const res = await revokeAccess(workspaceId, {
          path: entry.relativePath,
          kind: targetKind,
          principal,
          mode: 'remove-from-parent',
          // The ancestor is a FOLDER — strip the trailing `/access.md` so the
          // server resolves it as a folder target. The path is opaque to us
          // otherwise (repo-relative, echoed from the 409 sources).
          ancestor: ancestorAccessMd.replace(/\/?access\.md$/, ''),
          verb,
        });
        setData(res);
        setConfirmRemove(null);
      } catch (err) {
        setMutateError(err instanceof Error ? err.message : String(err));
        reload();
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, repoRelative, entry.relativePath, targetKind, reload],
  );

  /** Per-item override: add a `deny` at the target (optionally scoped to one verb), keeping the parent grant. */
  const doDenyHere = useCallback(
    async (principal: Principal, verb?: GrantVerb) => {
      if (!workspaceId || repoRelative === null) return;
      setBusy(true);
      setMutateError(null);
      try {
        const res = await revokeAccess(workspaceId, {
          path: entry.relativePath,
          kind: targetKind,
          principal,
          mode: 'deny-here',
          verb,
        });
        setData(res);
        setConfirmRemove(null);
      } catch (err) {
        setMutateError(err instanceof Error ? err.message : String(err));
        reload();
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, repoRelative, entry.relativePath, targetKind, reload],
  );

  const ownerNames = useMemo(() => {
    if (!data) return '';
    const names = [
      ...data.owners.roles,
      ...data.owners.users.map((u) => u.name || u.email),
    ];
    return names.slice(0, 3).join(', ');
  }, [data]);

  // One grantee row. Direct rows get the inline verb editor; inherited rows are
  // read-only with a Remove that opens the cascade flow; external rows are
  // read-only with no action.
  const renderRow = (p: PrincipalRow) => {
    const tone = avatarTone(p.label);
    return (
      // Wrapping, with a floor under the name block: on a narrow panel the meta
      // cluster (via… / verbs / Remove) drops to its own line rather than
      // squeezing the name to zero width — which left the `Role` badge sitting
      // on top of the "via …" label and pushed Remove off the panel's edge.
      <div key={p.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
        {p.kind !== 'user' ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken text-detail font-bold text-ink-muted">
            {initials(p.label)}
          </span>
        ) : (
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-detail font-bold"
            style={{ backgroundColor: tone.bg, color: tone.fg }}
          >
            {initials(p.label)}
          </span>
        )}
        <div className="min-w-36 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-ui font-medium text-ink">{p.label}</span>
            {p.isYou && <span className="shrink-0 text-ui text-ink-faint">(you)</span>}
            {p.kind !== 'user' && (
              // The same chip vocabulary as the suggest menu's trailing tags:
              // a role is a capability, a group is an audience — badge which.
              <Badge tone="outline" size="xs" className="shrink-0 uppercase">
                {p.kind === 'group' ? 'Group' : 'Role'}
              </Badge>
            )}
          </div>
          {p.sub && <div className="truncate text-detail text-ink-muted">{p.sub}</div>}
        </div>
        {canManage && p.manage === 'inherited' ? (
          // Inherited from a parent folder — read-only here. Leaf folder name only
          // (full path on hover); Remove opens the "Remove from parent?" flow.
          <div className="ml-auto flex max-w-full shrink-0 items-center gap-2">
            <span
              className="min-w-0 max-w-40 truncate text-detail italic text-ink-faint"
              title={p.ancestors.map(folderPath).join(', ')}
            >
              via {p.ancestors.map(folderLabel).join(', ')}
            </span>
            <span className="whitespace-nowrap text-detail text-ink-faint">
              {summarizeVerbs(p.verbs)}
            </span>
            <Button variant="danger" size="tiny" disabled={busy} onClick={() => doRevoke(p)}>
              Remove
            </Button>
          </div>
        ) : canManage && p.manage === 'external' ? (
          // No file-backed grant to remove here — managed elsewhere (a role or
          // group's membership, the everyone policy, or admin rescue).
          <span
            className="ml-auto shrink-0 text-detail text-ink-faint"
            title="Granted via a role or policy. Manage it there"
          >
            {summarizeVerbs(p.verbs)}
          </span>
        ) : canManage ? (
          <div className="ml-auto shrink-0">
            <Button
              variant="quiet"
              size="sm"
              disabled={busy}
              onClick={() => setOpenRowKey((k) => (k === p.key ? null : p.key))}
              trailingIcon={<ChevronDown size={14} />}
            >
              {summarizeVerbs(p.verbs)}
            </Button>
            {openRowKey === p.key && (
              <AnchoredMenu onDismiss={() => setOpenRowKey(null)}>
                {TIER_ROLES.map((role) => {
                  const k = ROLE_TO_KEY[role];
                  const checked = p.verbs[k];
                  const disabled =
                    busy ||
                    (role === 'Can edit' && p.verbs.owner) ||
                    (role === 'Can read' && (p.verbs.owner || p.verbs.write));
                  return (
                    <MenuItem
                      key={role}
                      disabled={disabled}
                      active={checked}
                      onClick={() => doToggleVerb(p.principal, role, checked)}
                      trailing={checked ? <Check size={14} className="text-accent" /> : undefined}
                    >
                      {role}
                    </MenuItem>
                  );
                })}
                <div className="my-1 border-t border-line" />
                {(() => {
                  const checked = p.verbs.download;
                  const disabled = busy || p.verbs.owner;
                  return (
                    <MenuItem
                      disabled={disabled}
                      active={checked}
                      onClick={() => doToggleVerb(p.principal, 'Can download', checked)}
                      trailing={checked ? <Check size={14} className="text-accent" /> : undefined}
                    >
                      Can download
                    </MenuItem>
                  );
                })()}
                <div className="my-1 border-t border-line" />
                <MenuItem
                  tone="danger"
                  disabled={busy}
                  onClick={() => {
                    setOpenRowKey(null);
                    doRevoke(p);
                  }}
                >
                  Remove access
                </MenuItem>
              </AnchoredMenu>
            )}
          </div>
        ) : (
          <span className="ml-auto shrink-0 text-detail text-ink-muted">
            {summarizeVerbs(p.verbs)}
          </span>
        )}
      </div>
    );
  };

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title="Manage access"
        size="lg"
        footer={
          <Button variant="primary" size="sm" onClick={onClose}>
            Done
          </Button>
        }
      >
        <p className="truncate text-detail text-ink-muted" title={entry.relativePath}>
          {entry.name}
        </p>

        {governed && canManage && (
          <div className="mt-3">
            {/* `items-start`, not `items-stretch`: the buttons are `rounded-full`,
                so stretching them to match the chip box turned Share into a
                circle the moment a chip wrapped the box onto a second line.
                `flex-wrap` lets them drop below the box rather than crushing it. */}
            <div className="relative flex flex-wrap items-start gap-1.5">
              <div className="relative min-w-48 flex-1">
                {/* A TextField that grew chips: same border, radius and focus
                    treatment as the primitive, wrapped so the chips can wrap. */}
                <div className="flex w-full flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1 focus-within:border-transparent focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-accent">
                  {pickedChips.map((c) => {
                    const label = principalLabel(c);
                    return (
                      <span
                        key={principalKey(c)}
                        className="inline-flex items-center gap-1 rounded-sm bg-sunken px-2 py-0.5 text-detail text-ink"
                      >
                        {label}
                        <button
                          type="button"
                          onClick={() => removeChip(c)}
                          className="rounded-xs text-ink-faint hover:text-danger"
                          aria-label={`Remove ${label}`}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    );
                  })}
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && addPending) {
                        e.preventDefault();
                        addChip(addPending);
                      }
                    }}
                    placeholder={pickedChips.length ? '' : 'Add people, groups, or roles…'}
                    className="min-w-32 flex-1 bg-transparent px-1 py-1 text-ui text-ink placeholder:text-ink-faint focus:outline-none"
                  />
                </div>
                {/* Defensive `?? []` on every field: a suggest response missing
                    `roles` or `groups` (version skew) must degrade to an empty
                    section, never a crash. Groups lead — they are the audience
                    concept grants are meant for; roles remain grantable below. */}
                {query.trim() && suggest && ((suggest.groups?.length ?? 0) > 0 || (suggest.roles?.length ?? 0) > 0 || (suggest.people?.length ?? 0) > 0) && (
                  <AnchoredMenu width="anchor" align="left" className="max-h-56 overflow-auto">
                    {(suggest.groups ?? []).map((g) => (
                      <MenuItem
                        key={`grp:${g}`}
                        onClick={() => addChip({ kind: 'group', group: g })}
                        trailing={
                          <span className="text-label uppercase text-ink-faint">group</span>
                        }
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-label font-bold text-ink-muted">
                          {initials(g)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{g}</span>
                      </MenuItem>
                    ))}
                    {(suggest.roles ?? []).map((g) => (
                      <MenuItem
                        key={`g:${g}`}
                        onClick={() => addChip({ kind: 'role', role: g })}
                        trailing={
                          <span className="text-label uppercase text-ink-faint">role</span>
                        }
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-label font-bold text-ink-muted">
                          {initials(g)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{g}</span>
                      </MenuItem>
                    ))}
                    {(suggest.people ?? []).map((p) => {
                      const tone = avatarTone(p.name || p.email);
                      return (
                        <MenuItem
                          key={`p:${p.email}`}
                          onClick={() => addChip({ kind: 'user', email: p.email, displayName: p.name })}
                          trailing={
                            <span className="max-w-40 truncate text-meta text-ink-faint">
                              {p.email}
                            </span>
                          }
                        >
                          <span
                            className="flex size-6 shrink-0 items-center justify-center rounded-full text-label font-bold"
                            style={{ backgroundColor: tone.bg, color: tone.fg }}
                          >
                            {initials(p.name || p.email)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{p.name || p.email}</span>
                        </MenuItem>
                      );
                    })}
                  </AnchoredMenu>
                )}
              </div>

              <div className="shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  className="max-w-44"
                  onClick={() => setVerbOpen((o) => !o)}
                  trailingIcon={<ChevronDown size={14} className="shrink-0" />}
                >
                  <span className="truncate">{summarizeVerbs(effectiveNewVerbs)}</span>
                </Button>
                {verbOpen && (
                  <AnchoredMenu onDismiss={() => setVerbOpen(false)}>
                    {TIER_ROLES.map((role) => {
                      const k = ROLE_TO_KEY[role];
                      const checked = effectiveNewVerbs[k];
                      const disabled =
                        (role === 'Can edit' && effectiveNewVerbs.owner) ||
                        (role === 'Can read' && (effectiveNewVerbs.owner || effectiveNewVerbs.write));
                      return (
                        <MenuItem
                          key={role}
                          disabled={disabled}
                          active={checked}
                          aria-pressed={checked}
                          onClick={() => setNewVerbs((v) => ({ ...v, [k]: !v[k] }))}
                          trailing={checked ? <Check size={14} className="text-accent" /> : undefined}
                        >
                          {role}
                        </MenuItem>
                      );
                    })}
                    <div className="my-1 border-t border-line" />
                    <MenuItem
                      disabled={effectiveNewVerbs.owner}
                      active={effectiveNewVerbs.download}
                      aria-pressed={effectiveNewVerbs.download}
                      onClick={() => setNewVerbs((v) => ({ ...v, download: !v.download }))}
                      trailing={
                        effectiveNewVerbs.download ? (
                          <Check size={14} className="text-accent" />
                        ) : undefined
                      }
                    >
                      Can download
                    </MenuItem>
                  </AnchoredMenu>
                )}
              </div>

              <Button
                variant="primary"
                size="sm"
                className="shrink-0"
                disabled={pickedChips.length === 0 || grantVerbs.length === 0 || busy}
                onClick={doGrant}
                leadingIcon={busy ? <Loader2 size={14} className="animate-spin" /> : undefined}
              >
                Share
              </Button>
            </div>
            {query.trim() && !addPending && !suggest?.peopleWithheld && (
              <p className="mt-1.5 text-detail text-ink-muted">
                Type a full email to add someone, or pick a group or role from the list.
              </p>
            )}
            {pickedChips.some(isEveryoneRole) && (
              <p className="mt-1.5 text-detail text-ink-muted">
                “Everyone” makes this {targetKind} publicly readable: it can only be granted read access.
              </p>
            )}
            {mutateError && (
              <Banner tone="danger" role="alert" className="mt-2 whitespace-pre-line">
                {mutateError}
              </Banner>
            )}
          </div>
        )}

        {!governed ? (
          <p className="py-8 text-center text-ui text-ink-muted">
            This item isn't part of the knowledge base, so it isn't governed by access control.
          </p>
        ) : loading ? (
          <p className="flex items-center justify-center gap-2 py-8 text-ui text-ink-muted">
            <Loader2 size={16} className="animate-spin" /> Loading access…
          </p>
        ) : error ? (
          <Banner tone="danger" role="alert" className="my-3">
            Couldn't load access: {error}
          </Banner>
        ) : (
          <>
            {!canManage && (
              <Banner tone="neutral" role="note" className="mt-3">
                Only people with edit access can share this {targetKind}.
                {ownerNames && <> Ask an owner: {ownerNames}.</>}
              </Banner>
            )}

            {/* Names WHICH RULE you are editing, and adapts to the target
                (proto:3625: `On this ` + file|folder). The sheet mixes rules
                set HERE with rules inherited from above, so a heading that
                says only "People with access" leaves the reader to work out
                which of the two lists below is which. The count rides it, as
                on every band in the app. */}
            <h3 className="mb-1 mt-4 flex items-baseline gap-2 text-label uppercase text-ink-faint">
              On this {targetKind}
              {directRows.length > 0 && (
                <span className="text-meta normal-case tabular-nums">{directRows.length}</span>
              )}
            </h3>

            {data && !data.readers.restricted && (
              <div className="flex items-center gap-3 py-1.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
                  <Globe size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-ui text-ink">Anyone can read</div>
                  <div className="text-detail text-ink-muted">
                    Public: every signed-in user can read this {targetKind}
                  </div>
                </div>
                {canManage && (
                  <Button
                    variant="danger"
                    size="tiny"
                    className="shrink-0"
                    disabled={busy}
                    onClick={removePublicRead}
                  >
                    Remove
                  </Button>
                )}
              </div>
            )}

            {directRows.length === 0 ? (
              <p className="py-2 text-ui text-ink-muted">
                {inheritedRows.length > 0
                  ? 'No one is granted directly here. Everyone below inherits access from a parent folder.'
                  : 'No explicit grants at this path.'}
              </p>
            ) : (
              directRows.map(renderRow)
            )}

            {inheritedRows.length > 0 && (
              <div className="mt-3 border-t border-line pt-2">
                {inheritedByFolder.folders.map(([ancestor, rows]) => {
                  const open = openSection === ancestor;
                  return (
                    <div key={ancestor}>
                      <button
                        type="button"
                        aria-expanded={open}
                        title={folderPath(ancestor)}
                        onClick={() => setOpenSection(open ? null : ancestor)}
                        className="flex w-full items-center gap-1.5 rounded-xs py-1 text-detail text-ink-muted hover:text-ink"
                      >
                        <ChevronDown
                          size={14}
                          className={`shrink-0 transition-transform ${open ? 'rotate-180' : '-rotate-90'}`}
                        />
                        <span className="min-w-0 truncate">
                          People invited to <b className="font-semibold">{folderLabel(ancestor)}</b>
                        </span>
                        <span className="ml-auto shrink-0 tabular-nums text-ink-faint">
                          {rows.length}
                        </span>
                      </button>
                      {open && (
                        <div className="mb-1">
                          {rows.map(renderRow)}
                          {/* The folder is both what the heading means and
                              where it changes (proto:3647). Without this the
                              only act available on an inherited grant is the
                              destructive one behind Remove. */}
                          {onManageAncestor && kbDirName && (
                            <Button
                              variant="quiet"
                              size="tiny"
                              className="mt-0.5"
                              onClick={() => {
                                const dir = ancestor.replace(/\/?access\.md$/, '');
                                onManageAncestor({
                                  // The same name the button just said. A
                                  // root-level `access.md` leaves `dir` empty,
                                  // and `''.split('/').pop()` is `''` — a
                                  // dialog with no title.
                                  name: folderLabel(ancestor),
                                  relativePath: `${kbDirName}/${dir}`,
                                  type: 'directory',
                                });
                              }}
                            >
                              {`Manage ${folderLabel(ancestor)} →`}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* A role that grants at the workspace level belongs to no
                    folder, so it cannot be filed under one. Named for what it
                    is rather than swept into the folder sections. */}
                {inheritedByFolder.external.length > 0 && (
                  <div>
                    <button
                      type="button"
                      aria-expanded={openSection === 'roles'}
                      onClick={() => setOpenSection(openSection === 'roles' ? null : 'roles')}
                      className="flex w-full items-center gap-1.5 rounded-xs py-1 text-detail text-ink-muted hover:text-ink"
                    >
                      <ChevronDown
                        size={14}
                        className={`shrink-0 transition-transform ${openSection === 'roles' ? 'rotate-180' : '-rotate-90'}`}
                      />
                      <span className="min-w-0 truncate">People with access through a role</span>
                      <span className="ml-auto shrink-0 tabular-nums text-ink-faint">
                        {inheritedByFolder.external.length}
                      </span>
                    </button>
                    {openSection === 'roles' && (
                      <div className="mb-1">{inheritedByFolder.external.map(renderRow)}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken text-ink-muted">
                <Lock size={16} />
              </span>
              <div className="flex-1">
                <div className="text-ui font-semibold text-ink">Restricted</div>
                <div className="text-detail text-ink-muted">
                  Only people granted access can edit this item.
                </div>
              </div>
            </div>
          </>
        )}
      </Dialog>

      {confirmRemove && (
        <Dialog
          open
          busy={busy}
          onClose={() => setConfirmRemove(null)}
          size="md"
          title={
            confirmRemove.ancestors.length ? 'Remove from parent folder?' : 'Restrict access here?'
          }
        >
          {(() => {
            // When the flow was triggered by unchecking ONE verb, the whole
            // confirmation is scoped to it ("their EDIT access", "remove EDIT
            // from the parent"); otherwise it's the whole principal.
            const va = confirmRemove.verb ? `${VERB_NOUN[confirmRemove.verb]} access` : 'access';
            return (
              <p className="text-ui leading-relaxed text-ink-muted">
                {confirmRemove.ancestors.length ? (
                  <>
                    {confirmRemove.label}'s {va} here is inherited from{' '}
                    <span
                      className="font-medium text-ink"
                      title={confirmRemove.ancestors.map(folderPath).join(', ')}
                    >
                      {confirmRemove.ancestors.map(folderLabel).join(', ')}
                    </span>
                    . Remove their {va} from the parent: which also removes it from other items in
                    that folder: or restrict just this {targetKind} while leaving the parent grant
                    intact.
                  </>
                ) : (
                  <>
                    {confirmRemove.label}'s {va} here comes from a role or policy, not a grant on
                    this {targetKind}. You can't remove it here. But you can restrict their {va} on
                    just this {targetKind} by adding a block.
                  </>
                )}
              </p>
            );
          })()}

          {mutateError && (
            <Banner tone="danger" role="alert" className="mt-3 whitespace-pre-line">
              {mutateError}
            </Banner>
          )}

          <div className="mt-4 flex flex-col gap-2">
            {confirmRemove.ancestors.length === 1 && (
              <Button
                variant="primary"
                className="w-full"
                disabled={busy}
                onClick={() =>
                  doRemoveFromParent(confirmRemove.principal, confirmRemove.ancestors[0], confirmRemove.verb)
                }
              >
                Remove from {folderLabel(confirmRemove.ancestors[0])}
              </Button>
            )}
            {confirmRemove.ancestors.length > 1 && (
              <>
                <p className="text-detail text-ink-muted">
                  Inherited from multiple folders. Remove from one at a time:
                </p>
                {confirmRemove.ancestors.map((a) => (
                  <Button
                    key={a}
                    variant="primary"
                    className="w-full"
                    disabled={busy}
                    onClick={() => doRemoveFromParent(confirmRemove.principal, a, confirmRemove.verb)}
                  >
                    Remove from {folderLabel(a)}
                  </Button>
                ))}
              </>
            )}
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => doDenyHere(confirmRemove.principal, confirmRemove.verb)}
            >
              Restrict just this {targetKind}
            </Button>
            <Button
              variant="quiet"
              className="w-full"
              disabled={busy}
              onClick={() => setConfirmRemove(null)}
            >
              Cancel
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
