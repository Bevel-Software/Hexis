import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { X, Lock, Loader2, ChevronDown, Check, Globe, CircleHelp } from 'lucide-react';
import {
  canCarryFrontmatter,
  folderGovernsAccessMessage,
  type FileTreeEntry,
} from '@bevel-software/platform-shared';
import {
  Badge,
  Banner,
  Button,
  Dialog,
  IconButton,
  MenuItem,
  MenuPanel,
  useDismissableMenu,
} from '../../../shared/components';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useAuth } from '../../auth/state/auth.context';
import {
  fetchFileAccess,
  grantAccess,
  revokeAccess,
  suggestPrincipals,
  PLUGIN_PRINCIPAL_VERBS,
  parsePluginPrincipalToken,
  pluginPrincipalLabel,
  pluginPrincipalToken,
  type ResolvedPrincipal,
  asInheritedError,
  type AccessEligible,
  type AccessResponse,
  type AccessUser,
  type DenialSources,
  type GrantVerb,
  type GrantSource,
  type GrantSources,
  type Principal,
  type SuggestResponse,
} from '../api';
import { EMAIL_RE, initials, labelInitials } from '../../../lib/email';

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
  /**
   * The target exists only on an open change request's branch. Access is then
   * read and written on THAT branch — the rules land in the proposed file and
   * merge with it — and the sheet says so. Takes precedence over `workspaceId`.
   * `branch: null` (the request could not be resolved) refuses to load rather
   * than falling back to a workspace the file does not exist on.
   */
  proposal?: { number: number; branch: string | null };
}

type Role = 'Owner' | 'Can edit' | 'Can read' | 'Can download';

/** Which verbs a principal holds at the target (independent flags). */
interface VerbSet {
  owner: boolean;
  write: boolean;
  read: boolean;
  download: boolean;
}

/** The three tiers a row can sit at, broadest first; download is not one of them. */
type Tier = 'Owner' | 'Can edit' | 'Can read';
const TIERS: Tier[] = ['Owner', 'Can edit', 'Can read'];

/** The tier a set sits at — its highest held one — or null when it holds nothing (a denied row). */
function tierOf(v: VerbSet): Tier | null {
  return v.owner ? 'Owner' : v.write ? 'Can edit' : v.read ? 'Can read' : null;
}

/**
 * The set a row ends up with after a click on one item of its menu, or null
 * when the item has nothing to do from where the row is (the item renders
 * disabled). The dialog then writes the DIFFERENCE between that set and what
 * the principal effectively has here (denials for what the set drops, grants
 * for what it adds — see `doApplyVerbSet`).
 *
 * The menu is TWO AXES, which is what its separator has always drawn, and a
 * click moves one axis and leaves the other where it is:
 *
 *   - Owner / Can edit / Can read are one exclusive tier. An unchecked tier is
 *     where the row goes; the held tier steps DOWN one (Owner → Can edit → Can
 *     read), which is what "unticking" the top of a nested set can mean. Can
 *     read at the top has nothing below it — taking read away is what Remove
 *     and Deny are for — so it is disabled there.
 *   - Can download toggles on its own. Under Owner it is conferred, not chosen,
 *     so it is disabled there; and a step down from Owner writes nothing for
 *     it either way (see the return). Turning it on carries read, the
 *     resolver's own fold (a person trusted with a copy may open it).
 *
 * Each item used to apply a fixed whole set instead — Can edit meant "edit and
 * no download", Can download meant "download and no edit" — so raising one axis
 * silently wrote a revoke or a denial on the other. That is the bug this
 * function replaces.
 */
function nextVerbSet(current: VerbSet, role: Role): VerbPick | null {
  if (role === 'Can download') {
    if (current.owner) return null;
    return { ...current, download: !current.download, read: true };
  }
  const held = tierOf(current);
  const target: Tier | null =
    role === held ? (TIERS[TIERS.indexOf(role) + 1] ?? null) : role;
  if (target === null) return null;
  return {
    owner: target === 'Owner',
    write: target !== 'Can read',
    read: true,
    // Owner confers download; below it the axis keeps what the row chose. A
    // row coming DOWN from Owner is left to the file: the download it shows
    // may be the owner line's fold (gone with that line) or a line of its
    // own (which stays), and the view cannot tell the two apart — so nothing
    // is revoked or granted for it, and the fresh view says which it was.
    download: target === 'Owner' ? true : current.owner ? undefined : current.download,
  };
}

/**
 * A destination for one row, as `nextVerbSet` states it: the three tier verbs
 * always, and `download` either stated or LEFT OUT — "write nothing for this
 * verb; whatever the file says after the other writes stands". The apply loop
 * neither drops nor grants an omitted verb.
 */
type VerbPick = Omit<VerbSet, 'download'> & { download?: boolean };

/**
 * The verbs in the order a set has to be APPLIED: broadest first.
 *
 * Lowering must start at the top because a grant folds downward inside one
 * scope — denying `write` while a local `owner:` grant still stands would be
 * refused by the server as ineffective, since owner confers write. Stripping
 * owner first removes the thing that was conferring it.
 *
 * Raising reads the same order for the opposite reason: granting `owner` first
 * confers write, download and read in one line, so the later verbs are already
 * satisfied and no redundant second grant is written.
 */
const VERBS_BROADEST_FIRST: GrantVerb[] = ['owner', 'write', 'download', 'read'];

/** The `VerbSet` key each grant verb reads. */
const VERB_TO_KEY: Record<GrantVerb, keyof VerbSet> = {
  owner: 'owner',
  write: 'write',
  read: 'read',
  download: 'download',
};

/**
 * The fewest grant lines that produce a set — the single highest tier verb
 * (the lower ones fold in server-side) plus download when the set has it
 * without owner. A bare `read` is only worth writing when nothing else already
 * confers read, and download does.
 *
 * The same minimisation the add-row's `grantVerbs` does, as a function of a set
 * so the row menu can reuse it. Deriving it from the SET rather than from what
 * each intermediate response reports also keeps the write list deterministic:
 * a response that has not caught up cannot make the loop write `read:` under an
 * `owner:` it just granted.
 */
function minimalGrantVerbs(set: VerbPick): GrantVerb[] {
  const verbs: GrantVerb[] = [];
  if (set.owner) verbs.push('owner');
  else if (set.write) verbs.push('write');
  else if (set.read && !set.download) verbs.push('read');
  if (set.download && !set.owner) verbs.push('download');
  return verbs;
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
  kind: 'user' | 'role' | 'group' | 'plugin';
  isYou: boolean;
  /**
   * For a person row: whether an account exists for the email yet. `false`
   * earns the "hasn't signed in yet" note beside the name — the grant is
   * real and unaffected either way. `undefined` means the server did not say
   * (an older build), which is NOT the same as "no account" and shows
   * nothing.
   */
  hasAccount?: boolean;
  /** The principal to send on grant / revoke. */
  principal: Principal;
  /** Per-verb origin of this row's access (from the resolver). */
  sources?: GrantSources;
  /**
   * Per-verb origin of this row's RESTRICTIONS — where each verb the principal
   * does not hold is denied. A `direct` entry is a denial written on this
   * target: the row's "restricted here", and what the menu lifts when a higher
   * set is picked.
   */
  denials?: DenialSources;
  /**
   * How this row may be managed HERE, derived from its local ENTRIES — grants
   * and denials alike (both MECE: every source is `direct` or `ancestor`):
   *   - 'direct'    — ≥1 verb is granted, or denied, directly on the target.
   *                   The row belongs to this folder's own list, and Remove
   *                   acts in place.
   *   - 'inherited' — every entry naming this principal lives in an ancestor
   *                   folder; Remove opens the "Remove from parent?" flow.
   *   - 'external'  — no file-backed entry for any verb (a defensive fallback;
   *                   a real grantee row always resolves to direct/ancestor,
   *                   since rows are built from file-named principals). Shown
   *                   with the menu but no Remove.
   *
   * A DENIAL counts as a local entry, and that is the whole point: a person
   * restricted here has no local grant left, and classifying on grants alone
   * dropped them into the collapsed inherited section looking removed.
   */
  manage: 'direct' | 'inherited' | 'external';
  /**
   * The distinct ancestor access.md path(s) holding ANY entry for this row —
   * where the rules naming this principal live, which is what "via Sales" and
   * the parent-folder grouping report.
   */
  ancestors: string[];
  /**
   * The subset of those that GRANT — the only ones "Remove from <folder>" can
   * act on. An ancestor that merely denies is not where this person's access
   * comes from, and revoking them there would LIFT a restriction in answer to a
   * click that asked to remove access.
   */
  grantAncestors: string[];
  /** True when every verb is denied by an entry on this target — "Denied here". */
  deniedHere: boolean;
}

/** The four grant verbs, for whole-set reasoning. */
const ALL_VERBS: GrantVerb[] = ['owner', 'write', 'read', 'download'];

/** Every source list in a per-verb map, empty entries dropped. */
function sourceLists(map: GrantSources | DenialSources | undefined): GrantSource[][] {
  return map ? Object.values(map).filter((l): l is GrantSource[] => !!l && l.length > 0) : [];
}

/** The distinct ancestor `access.md` paths named across per-verb source maps. */
function ancestorPaths(...maps: (GrantSources | DenialSources | undefined)[]): string[] {
  return [
    ...new Set(
      maps
        .flatMap(sourceLists)
        .flatMap((l) => l.filter((s) => s.kind === 'ancestor').map((s) => s.path)),
    ),
  ];
}

/**
 * Classify a row's manageability from its per-verb entries — grants AND
 * denials, because a restriction is as much an entry on this target as a grant:
 *   - any verb granted directly, or denied directly → 'direct' (this folder's
 *     own list; the row is edited in place).
 *   - else any ancestor entry → 'inherited' (remove-from-parent / restrict here).
 *   - else no entry at all → 'external' (defensive fallback; a real grantee row
 *     always has a file entry, since rows are built from file-named principals).
 */
function classifyManage(
  sources: GrantSources | undefined,
  denials: DenialSources | undefined,
): { manage: 'direct' | 'inherited' | 'external'; ancestors: string[]; grantAncestors: string[] } {
  // A row is 'direct' when ANY verb's WINNING grant source (the closest, `[0]`)
  // is direct — even if that verb is ALSO inherited (`[direct, ancestor]`); the
  // inherited tail still feeds `ancestors`, so Remove can chain to the parent
  // after stripping the direct entry. A direct DENIAL counts the same way: it is
  // a rule this target holds about this principal.
  const hasLocalEntry =
    sourceLists(sources).some((l) => l[0]?.kind === 'direct') ||
    sourceLists(denials).some((l) => l.some((s) => s.kind === 'direct'));
  const ancestors = ancestorPaths(sources, denials);
  // Kept apart from `ancestors` on purpose: an ancestor DENIAL is a real entry
  // (it classifies the row, and it is where the rule lives) but it is not a
  // place access can be removed from.
  const grantAncestors = ancestorPaths(sources);
  if (hasLocalEntry) return { manage: 'direct', ancestors, grantAncestors };
  if (ancestors.length > 0) return { manage: 'inherited', ancestors, grantAncestors };
  return { manage: 'external', ancestors: [], grantAncestors: [] };
}

/**
 * A short, human folder label for an ancestor `access.md` path. Renders the
 * LEAF folder only (the deepest segment) so long chains don't overflow the row;
 * the full repo-relative path is exposed separately as a hover title.
 */
function folderLabel(accessMdPath: string): string {
  const dir = accessMdPath.replace(/\/?access\.md$/, '');
  if (dir === '') return WHOLE_WORKSPACE;
  const segs = dir.split('/');
  return segs[segs.length - 1];
}

/** The full folder path (for a hover title), repo-relative. */
function folderPath(accessMdPath: string): string {
  const dir = accessMdPath.replace(/\/?access\.md$/, '');
  return dir === '' ? WHOLE_WORKSPACE : dir;
}

/**
 * What the repository root is called to a business user. "The root folder" is
 * a repository word; a grant at the root reaches everything in the workspace,
 * and that is what the reader needs to know.
 */
const WHOLE_WORKSPACE = 'the whole workspace';

/** True when an ancestor `access.md` path is the repository root's. */
function isRootAccessMd(accessMdPath: string): boolean {
  return accessMdPath.replace(/\/?access\.md$/, '') === '';
}

/**
 * One line per kind of grantee, in business words. Shown together behind the
 * "What can I share with?" control, and one at a time as the tooltip and
 * accessible description of the group / role / plugin tags, so each word is
 * explained where it is met.
 */
const PRINCIPAL_KIND_HELP = {
  user: 'People: one person, by email.',
  group:
    'Groups: a way to group people together and give them access in the app. A group can be a team or department, like Engineering, or a functional group, like skill reviewers.',
  role: 'Roles: special app roles that give people extra abilities in the app. They are pre-defined; you can only add or remove people. Example: Admin, which opens the platform and user management screens.',
  plugin: 'Plugins: the readers, writers or owners of a plugin, whoever they are at the time.',
} as const satisfies Record<Principal['kind'], string>;

/**
 * What a person with no account yet is called, beside their chip and beside
 * their row. Granting ahead of a first sign-in is supported and stays
 * supported — under single sign-on the account is created BY that sign-in —
 * so this is a LABEL, never a warning and never a refusal: the grant saves
 * exactly as any other. It is here so a mistyped address is visible, and it
 * disappears on its own the first time that person signs in.
 */
const NO_ACCOUNT_NOTE = "hasn't signed in yet";
const NO_ACCOUNT_HELP =
  'No account for this email yet. The grant is saved and takes effect the moment they first sign in — if you did not expect this, check the spelling.';

/** The note itself — muted and small, the same weight as a row's second line. */
function NoAccountNote() {
  return (
    <span
      className="shrink-0 whitespace-nowrap text-detail italic text-ink-faint"
      title={NO_ACCOUNT_HELP}
      aria-description={NO_ACCOUNT_HELP}
    >
      {NO_ACCOUNT_NOTE}
    </span>
  );
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
      : p.kind === 'plugin'
        // The server keys plugin principals by their full token (`p:plugin/gtm/read`).
        ? `p:${pluginPrincipalToken(p.plugin, p.verb).toLowerCase()}`
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

/** Look a row/principal key up in a response's `denials` map, same `g:` fallback. */
function lookupDenials(
  denials: AccessResponse['denials'] | undefined,
  key: string,
): DenialSources | undefined {
  return denials?.[key] ?? (key.startsWith('g:') ? denials?.[`r:${key.slice(2)}`] : undefined);
}

/** The checklist order; download is independent and rendered separately. */
const TIER_ROLES: Role[] = TIERS;

/**
 * A row's verb menu, top to bottom — the tiers, then download, then (added by
 * the row itself) Deny. Broadest first, so "less than this" reads downwards.
 */
const MENU_ROLES: Role[] = [...TIER_ROLES, 'Can download'];

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

/**
 * A short summary of the verbs a row holds, for the dropdown trigger. Read is
 * folded in by write/owner/download before a `VerbSet` reaches here (see
 * `effectiveNewVerbs` and the row aggregation), so a download-only grant reads
 * “Can read, Can download” — what the resolver actually gives.
 */
function summarizeVerbs(v: VerbSet): string {
  const parts: string[] = [];
  if (v.owner) parts.push('Owner');
  else if (v.write) parts.push('Can edit');
  else if (v.read) parts.push('Can read');
  if (v.download) parts.push('Can download');
  return parts.length ? parts.join(', ') : 'No access';
}

/**
 * What a row's verb menu says beside ONE verb: where it comes from, or why it
 * is off. Short enough to sit in a menu item without wrapping — the leaf folder
 * name, as everywhere else in the sheet.
 *
 *   - held from a parent      → "from Sales"
 *   - denied by an entry here → "restricted here"  (the restriction this ticket
 *                               exists to make visible; picking a set that
 *                               includes the verb lifts it)
 *   - denied by a parent      → "restricted in Sales"
 *   - held by an entry here, or simply never granted → nothing to explain.
 */
function verbNote(row: PrincipalRow, verb: GrantVerb): string | undefined {
  if (row.verbs[VERB_TO_KEY[verb]]) {
    const winner = (row.sources?.[verb] ?? [])[0];
    return winner?.kind === 'ancestor' ? `from ${folderLabel(winner.path)}` : undefined;
  }
  const denial = (row.denials?.[verb] ?? [])[0];
  if (!denial) return undefined;
  return denial.kind === 'direct' ? 'restricted here' : `restricted in ${folderLabel(denial.path)}`;
}

/**
 * What a row's menu trigger reads. A wholly denied principal is not "No access"
 * — that is what someone never named here would look like. It is a decision
 * somebody made on this target, and the row says so.
 */
function rowSummary(row: PrincipalRow): string {
  return row.deniedHere ? 'Denied here' : summarizeVerbs(row.verbs);
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
 * The most a content-sized menu grows to before its items start truncating.
 * Wide enough for "Can download · from the whole workspace ✓" on one line;
 * narrow enough that a folder with a very long name cannot turn the menu
 * into a banner.
 */
const MENU_MAX_WIDTH = 360;

/**
 * A dropdown panel that escapes the dialog's scroll container.
 *
 * `Dialog` renders its body inside `overflow-y-auto` so a long access list
 * scrolls under the pinned header and footer. An ABSOLUTELY positioned menu in
 * that box is clipped by it: open the verb menu on a low grantee row and
 * everything past the first item or two — "Can download" included — is cut off
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
   * The control that opened us. Clicks on it are the trigger's own business
   * (its handler toggles), and Escape returns focus to it. Goes with
   * `onDismiss`; a stable ref, as `useDismissableMenu` lists it in its deps.
   */
  triggerRef,
  /**
   * Panel width in px, `'anchor'` to match the trigger (the combobox case), or
   * `'content'` to fit the widest item (a menu whose items carry notes — "from
   * the whole workspace" — that a trigger-sized panel would truncate the LABEL
   * to make room for). Clamped up to {@link MENU_MIN_WIDTH} either way, and
   * `'content'` is clamped down to {@link MENU_MAX_WIDTH} and the viewport.
   */
  width = MENU_MIN_WIDTH,
  /** Which edge lines up with the anchor's. */
  align = 'right',
  className = '',
  children,
}: {
  onDismiss?: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
  width?: number | 'anchor' | 'content';
  align?: 'left' | 'right';
  className?: string;
  children: ReactNode;
}) {
  const dismissable = onDismiss !== undefined;
  // The hook owns both contracts this component used to carry by hand: it
  // mirrors a fresh `onDismiss` arrow into a ref itself (so its document
  // listeners subscribe once per open menu), and it registers the open menu
  // as a modal layer (so Escape peels it before the Dialog hosting it, and
  // one press never closes two layers).
  const panelRef = useDismissableMenu<HTMLDivElement>({
    open: dismissable,
    onClose: () => onDismiss?.(),
    returnFocusTo: triggerRef,
  });
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchorEl = panel?.parentElement ?? null;
    const place = () => {
      const el = panelRef.current;
      const anchor = el?.parentElement?.getBoundingClientRect();
      if (!anchor || !el) return;
      let w: number;
      if (width === 'content') {
        // Let the panel take its natural width for one measurement, then pin
        // it: what the widest item needs, within the caps. The observer on
        // the panel sees only the pinned size, which is unchanged whenever the
        // content is, so this does not feed it.
        el.style.width = 'max-content';
        const natural = el.offsetWidth;
        w = Math.max(
          MENU_MIN_WIDTH,
          Math.min(natural, MENU_MAX_WIDTH, window.innerWidth - 2 * MENU_MARGIN),
        );
      } else {
        w = Math.max(width === 'anchor' ? anchor.width : width, MENU_MIN_WIDTH);
      }
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
    // A content-sized panel is PINNED to a width, so the resize observer above
    // cannot see its items change under it — and they do while a row menu
    // stays open across writes: notes ("from Sales") and check marks come and
    // go with each fresh view. Re-measure on any change to what the panel
    // holds. Children and text only, not attributes: `place` writes the
    // panel's own style, which must not re-trigger it.
    const contents = new MutationObserver(place);
    if (panel) contents.observe(panel, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', place);
    // Capture phase: the dialog body is what scrolls, and scroll events don't
    // bubble to `window`.
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      contents.disconnect();
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
 * Every row the sheet shows for one resolved access response — ONE row per
 * principal, carrying its effective verb set, where each held verb comes from,
 * and where each withheld one is denied.
 *
 * A pure function of the response rather than a hook body, because the apply
 * loop re-derives rows from each intermediate server response as it walks a
 * picked set: it has to ask "does the principal still hold write after that
 * call?" between requests, and the answer must come from the same aggregation
 * the UI renders — not a second, subtly different reading of the payload.
 */
function buildRows(data: AccessResponse | null, myEmail: string): PrincipalRow[] {
  if (!data) return [];
  // Aggregate the resolver lists into ONE row per principal carrying its
  // independent verb set. Membership IS the displayed set — we do NOT subtract
  // the rollup. The resolver already folds owner⊇write⊇read on the lower lists,
  // so an owner legitimately shows owner+write+read checked; download is its own
  // axis (owner folds in, write does not), sourced from `downloaders` — and it
  // folds DOWN into read, so a download row shows read checked too.
  const rows = new Map<string, PrincipalRow>();
  // Kinded collective list for one eligible set. Older servers omit
  // `principals` (version skew) — fall back to the name-only `roles`,
  // treating everything as a role (the pre-groups display).
  const collectivesOf = (list: AccessEligible): ResolvedPrincipal[] =>
    list.principals ?? list.roles.map((name) => ({ name, kind: 'role' as const }));
  const touchCollective = (c: ResolvedPrincipal): PrincipalRow => {
    // Rows are keyed by KIND + name (`g:`/`r:`/`p:`) — the backend treats a
    // bare `Product` (group) and `role/Product` (role) as DIFFERENT
    // principals, so a group and a role sharing a name are two rows, each
    // mutating its own grant. Collapsing them to one row silently pointed
    // every edit at the group and hid the role's grant entirely. A plugin
    // principal's name is its full `plugin/<Name>/<verb>` token.
    const key =
      c.kind === 'group'
        ? `g:${c.name.toLowerCase()}`
        : c.kind === 'plugin'
          ? `p:${c.name.toLowerCase()}`
          : `r:${c.name.toLowerCase()}`;
    let row = rows.get(key);
    if (!row) {
      const plugin = c.kind === 'plugin' ? parsePluginPrincipalToken(c.name) : null;
      row = {
        key,
        label: plugin ? pluginPrincipalLabel(plugin.plugin, plugin.verb) : c.name,
        kind: c.kind,
        isYou: false,
        principal:
          c.kind === 'group'
            ? { kind: 'group', group: c.name }
            : plugin
              ? { kind: 'plugin', plugin: plugin.plugin, verb: plugin.verb }
              : { kind: 'role', role: c.name },
        verbs: { owner: false, write: false, read: false, download: false },
        manage: 'direct',
        ancestors: [],
        grantAncestors: [],
        deniedHere: false,
      };
      rows.set(key, row);
    }
    return row;
  };
  const touchUser = (u: AccessUser): PrincipalRow => {
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
        // Whoever names this person first wins — the lists are views of the
        // same account, so the flag cannot differ between them.
        hasAccount: u.hasAccount,
        principal: { kind: 'user', email: u.email, displayName: u.name || u.email },
        verbs: { owner: false, write: false, read: false, download: false },
        manage: 'direct',
        ancestors: [],
        grantAncestors: [],
        deniedHere: false,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const c of collectivesOf(data.owners)) touchCollective(c).verbs.owner = true;
  for (const u of data.owners.users) touchUser(u).verbs.owner = true;
  for (const c of collectivesOf(data.eligible)) touchCollective(c).verbs.write = true;
  for (const u of data.eligible.users) touchUser(u).verbs.write = true;
  // Read grants are rows whether or not the node is public: on a public
  // node they are what MAKES it public, and a row is the ONE place any
  // grant is removed. The built-in `everyone` is a row like any principal
  // — when a file spells it. A derived everyone (public only through a
  // plugin principal) has no line of its own; the plugin's row is that grant.
  for (const c of collectivesOf(data.readers)) {
    if (c.kind === 'role' && isEveryoneRole({ kind: 'role', role: c.name })) {
      if (!lookupSources(data.sources, 'r:everyone')?.read?.length) continue;
      const row = touchCollective(c);
      row.label = 'Everyone';
      row.verbs.read = true;
      continue;
    }
    touchCollective(c).verbs.read = true;
  }
  for (const u of data.readers.users) touchUser(u).verbs.read = true;
  for (const c of collectivesOf(data.downloaders)) touchCollective(c).verbs.download = true;
  for (const u of data.downloaders.users) touchUser(u).verbs.download = true;

  // The principals this target RESTRICTS. They hold nothing through it, so no
  // eligible list carries them — and before the server reported them, writing a
  // restriction made the person disappear from the sheet that wrote it. They get
  // a row with an empty verb set; the denial map below supplies the rest.
  for (const c of data.deniedHere?.principals ?? []) {
    const row = touchCollective(c);
    if (c.kind === 'role' && isEveryoneRole({ kind: 'role', role: c.name })) row.label = 'Everyone';
  }
  for (const u of data.deniedHere?.users ?? []) touchUser(u);

  // Download implies read, the way write does. The server folds it into
  // `readers` too, so this is belt-and-braces for an older backend — but it is
  // also what makes the row's Read box render checked-and-implied next to a
  // Download it cannot be unticked without.
  for (const row of rows.values()) if (row.verbs.download) row.verbs.read = true;

  // Attach each row's per-verb grants and denials, and the manageability they
  // imply (direct / inherited / external), keyed by the same row key (with the
  // `g:` → `r:` version-skew fallback for group rows).
  for (const row of rows.values()) {
    row.sources = lookupSources(data.sources, row.key);
    row.denials = lookupDenials(data.denials, row.key);
    const { manage, ancestors, grantAncestors } = classifyManage(row.sources, row.denials);
    row.manage = manage;
    row.ancestors = ancestors;
    row.grantAncestors = grantAncestors;
    // "Denied here" is the whole-principal block: every verb denied by an entry
    // on this target. A partial restriction (edit denied, read still inherited)
    // is emphatically NOT this — it is a lowered set, and says so per verb.
    row.deniedHere = ALL_VERBS.every((v) =>
      (row.denials?.[v] ?? []).some((s) => s.kind === 'direct'),
    );
  }

  return [...rows.values()];
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
  proposal,
}: Props) {
  // `kbDirName` stays context-sourced: it names the clone directory, which is
  // the same on every branch.
  const { workspaceId: ctxWorkspaceId, kbDirName } = useWorkspace();
  const proposalBranchMissing = !!proposal && !proposal.branch;
  // Workspace ids are the URL-encoded branch name (see `workspaceIdForBranch`).
  const workspaceId = proposal
    ? proposal.branch
      ? encodeURIComponent(proposal.branch)
      : null
    : (workspaceIdProp ?? ctxWorkspaceId);
  const { user } = useAuth();
  const [data, setData] = useState<AccessResponse | null>(null);
  const [loading, setLoading] = useState(!proposalBranchMissing);
  const [error, setError] = useState<string | null>(
    proposalBranchMissing
      ? `The branch of change request #${proposal.number} could not be found.`
      : null,
  );

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
  // The triggers the two verb menus return focus to on Escape. One ref serves
  // every grantee row: only the OPEN row's trigger carries it (one menu at a
  // time), so it always names the button whose menu is on screen.
  const openRowTriggerRef = useRef<HTMLButtonElement>(null);
  const verbTriggerRef = useRef<HTMLButtonElement>(null);
  /** The add row's text field — where the caret goes back to after a pick. */
  const queryInputRef = useRef<HTMLInputElement>(null);
  // The "What can I share with?" explainer beside the add field.
  const [kindHelpOpen, setKindHelpOpen] = useState(false);
  const kindHelpTriggerRef = useRef<HTMLButtonElement>(null);
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

  /**
   * The LATEST thing the server said about each email — from a suggestion or
   * from the loaded view, whichever spoke most recently. Not a set of
   * positives: an answer that explicitly says `hasAccount: false` about
   * someone previously reported as having an account (an account erased while
   * this dialog is open) has to be able to take the claim back, which an
   * accumulate-only set cannot do.
   *
   * It IS accumulated across answers rather than read off the current one, so
   * an answer landing after a chip was added still corrects that chip.
   *
   * Version skew: a server that says nothing about a person it has named
   * (`hasAccount === undefined`) is recorded as HAVING an account — silence is
   * not a claim of absence, so an older build labels nobody.
   */
  const [accountStatus, setAccountStatus] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const learnAccounts = useCallback((people: readonly AccessUser[]) => {
    if (people.length === 0) return;
    setAccountStatus((prev) => {
      let next: Map<string, boolean> | null = null;
      for (const p of people) {
        const email = p.email.trim().toLowerCase();
        if (!email) continue;
        const has = p.hasAccount !== false;
        if (prev.get(email) === has) continue;
        next ??= new Map(prev);
        next.set(email, has);
      }
      return next ?? prev;
    });
  }, []);

  /**
   * Addresses an account-aware suggest answer has actually RULED ON — the
   * queries such an answer came back for, canonical. Absence from `people` is
   * evidence of "no account" only for one of these: a lookup that failed, or
   * one served by a build that does not report accounts, says nothing at all,
   * and a chip must not be labelled on a guess in either case.
   */
  const [lookedUp, setLookedUp] = useState<ReadonlySet<string>>(() => new Set());
  const noteLookedUp = useCallback((email: string) => {
    setLookedUp((prev) => (prev.has(email) ? prev : new Set(prev).add(email)));
  }, []);

  /**
   * Whether a CHIP earns the note. Two ways to know, and nothing else counts:
   * the server said `hasAccount: false` about that address, or it answered a
   * lookup of that exact address and did not name it — which, from a build
   * that reports accounts, is the same fact stated by omission.
   *
   * Rows do NOT go through here — a row reads its own `hasAccount` straight
   * from the view, which always names the person it is a row for.
   */
  const lacksAccount = useCallback(
    (email: string): boolean => {
      const key = email.trim().toLowerCase();
      const status = accountStatus.get(key);
      return status === undefined ? lookedUp.has(key) : !status;
    },
    [accountStatus, lookedUp],
  );

  // The loaded view is the other place accounts are named: someone already
  // granted here and already signed in must not pick the note up when their
  // address is typed again, and someone granted here who never signed in
  // should carry it on the chip as well as on the row.
  useEffect(() => {
    if (!data) return;
    learnAccounts([
      ...data.eligible.users,
      ...data.readers.users,
      ...data.owners.users,
      ...data.downloaders.users,
    ]);
  }, [data, learnAccounts]);

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
        .then((res) => {
          setSuggest(res);
          learnAccounts(res.people ?? []);
          // Only an answer that SAYS it rules on accounts turns "not in the
          // answer" into "no account". Without that the answer is silent on
          // the question, so the address stays unjudged and unlabelled.
          //
          // `peopleWithheld` is checked here too, not just trusted to have
          // already made `accountsKnown` false: a withheld list names nobody
          // by design (the harvesting guard), so reading it as "nobody has an
          // account" would label every address at once. Either flag alone is
          // enough to say nothing.
          if (res.accountsKnown && !res.peopleWithheld) noteLookedUp(q.toLowerCase());
        })
        .catch(() => setSuggest(null));
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, workspaceId, repoRelative, learnAccounts, noteLookedUp]);

  const myEmail = user?.email?.toLowerCase() ?? '';

  const principals = useMemo<PrincipalRow[]>(() => buildRows(data, myEmail), [data, myEmail]);

  // Split direct (granted here, editable) from inherited/external (granted at a
  // parent or via a role) so the main list stays clean and the rest collapses
  // into a hidden "Inherited access" section.
  const directRows = useMemo(() => principals.filter((p) => p.manage === 'direct'), [principals]);
  const inheritedRows = useMemo(
    () => principals.filter((p) => p.manage !== 'direct'),
    [principals],
  );
  // The read side of a folder-governed file: who can open it, shown read-only.
  const readerRows = useMemo(() => principals.filter((p) => p.verbs.read), [principals]);

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

  /**
   * Keep the row a write just changed on screen. A write can MOVE a row: revoke
   * someone's local edit and, if a parent still grants them read, they file
   * under "People invited to <parent>" — which is collapsed, so the person the
   * reader was just editing vanishes and looks removed. Open the section the
   * row now lives in (its nearest granting folder, or the roles group); a row
   * that stays on this folder needs nothing.
   */
  const revealRow = useCallback((row: PrincipalRow | undefined) => {
    if (!row || row.manage === 'direct') return;
    setOpenSection(row.ancestors.length === 0 ? 'roles' : row.ancestors[0]!);
  }, []);

  const governed = repoRelative !== null;
  // A file that cannot carry frontmatter (a PDF, a deck, an image) has no rules
  // of its own: its folder's rules govern it, and the grant / revoke routes
  // refuse it. The server's ruling (`governedByFolder`, from the same shared
  // predicate over the resolver's registered extensions) decides once the view
  // has loaded; until then the shared predicate's core set stands in, so the
  // sheet never flashes a field for a PDF.
  const folderGoverns =
    targetKind === 'file' &&
    repoRelative !== null &&
    (data ? data.governedByFolder !== undefined : !canCarryFrontmatter(repoRelative));
  const governingFolder =
    data?.governedByFolder ??
    (repoRelative !== null && repoRelative.includes('/')
      ? repoRelative.slice(0, repoRelative.lastIndexOf('/'))
      : '');
  const governingFolderLabel =
    governingFolder === '' ? WHOLE_WORKSPACE : governingFolder.slice(governingFolder.lastIndexOf('/') + 1);
  // The dialog can mutate only if the current user can write this path's access
  // config — exactly what the backend gate enforces. `canWrite` on the path is
  // the same signal (folder access.md / node frontmatter both gate on write).
  // Never on a folder-governed file: there is nothing here to write to.
  const canManage = !!data?.canWrite && !folderGoverns;

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
    p.kind === 'role'
      ? p.role
      : p.kind === 'group'
        ? p.group
        : p.kind === 'plugin'
          ? pluginPrincipalLabel(p.plugin, p.verb)
          : p.displayName || p.email;

  const addChip = useCallback((p: Principal) => {
    setPickedChips((chips) =>
      chips.some((c) => principalKey(c) === principalKey(p)) ? chips : [...chips, p],
    );
    setQuery('');
    setSuggest(null);
    // A pick from the list moved focus onto the list's button, which is about
    // to unmount; the next name is typed into the field, so put the caret
    // back there rather than making the person click into the white space.
    queryInputRef.current?.focus();
  }, []);

  // What the list OFFERS: the server's suggestions minus what is already a
  // chip. A group picked once has nothing to add a second time, and seeing it
  // offered again reads as "did that not take?".
  const offered = useMemo(() => {
    if (!suggest) return null;
    const picked = new Set(pickedChips.map(principalKey));
    return {
      groups: (suggest.groups ?? []).filter((g) => !picked.has(principalKey({ kind: 'group', group: g }))),
      roles: (suggest.roles ?? []).filter((r) => !picked.has(principalKey({ kind: 'role', role: r }))),
      plugins: (suggest.pluginPrincipals ?? [])
        .flatMap((name) => PLUGIN_PRINCIPAL_VERBS.map((verb) => ({ name, verb })))
        .filter(({ name, verb }) => !picked.has(principalKey({ kind: 'plugin', plugin: name, verb }))),
      people: (suggest.people ?? []).filter(
        (p) => !picked.has(principalKey({ kind: 'user', email: p.email, displayName: p.name })),
      ),
    };
  }, [suggest, pickedChips]);
  const offersAnything =
    !!offered &&
    (offered.groups.length > 0 ||
      offered.roles.length > 0 ||
      offered.plugins.length > 0 ||
      offered.people.length > 0);

  const removeChip = useCallback((p: Principal) => {
    setPickedChips((chips) => chips.filter((c) => principalKey(c) !== principalKey(p)));
  }, []);

  // The new-grant checklist stores independent flags, but the nesting folds for
  // display: Owner implies edit + download + read; Edit implies read; Download
  // implies read too (a person trusted with a copy may open it).
  // `effectiveNewVerbs` is what the boxes render as checked.
  const effectiveNewVerbs = useMemo<VerbSet>(
    () => ({
      owner: newVerbs.owner,
      write: newVerbs.owner || newVerbs.write,
      read: newVerbs.owner || newVerbs.write || newVerbs.download || newVerbs.read,
      download: newVerbs.owner || newVerbs.download,
    }),
    [newVerbs],
  );

  // The minimal verb list to send: the single highest tier verb (the lower ones
  // fold in server-side) plus download when it's chosen independently of owner.
  // A bare `read` line is only worth writing when nothing else already confers
  // read — download does, so Download alone (or Read + Download) sends `download`
  // and no redundant second grant.
  const grantVerbs = useMemo<GrantVerb[]>(() => {
    const verbs: GrantVerb[] = [];
    if (effectiveNewVerbs.owner) verbs.push('owner');
    else if (effectiveNewVerbs.write) verbs.push('write');
    else if (effectiveNewVerbs.read && !effectiveNewVerbs.download) verbs.push('read');
    if (effectiveNewVerbs.download && !effectiveNewVerbs.owner) verbs.push('download');
    return verbs;
  }, [effectiveNewVerbs]);

  /** Grant every picked principal the chosen verbs. Resolves `true` only when all of them landed. */
  const doGrant = useCallback(async (): Promise<boolean> => {
    if (!workspaceId || repoRelative === null || pickedChips.length === 0 || grantVerbs.length === 0)
      return false;
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
        // also selected for the other chips. Every selection that reaches this
        // point confers read (Share is disabled while `grantVerbs` is empty, and
        // each of the four boxes now implies read), so the clamp always has a
        // verb to send: "Can download" on Everyone shares it publicly readable
        // and drops only the download half the backend would refuse anyway.
        const verbsForPrincipal = isEveryoneRole(principal)
          ? (['read'] as GrantVerb[])
          : grantVerbs;
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
      return failures.length === 0;
    } finally {
      reload();
      setBusy(false);
    }
  }, [workspaceId, repoRelative, pickedChips, entry.relativePath, targetKind, grantVerbs, reload]);

  // The footer's one primary action. With picks it shares them and closes; a
  // grant that fails keeps the dialog — and the picks — up with the failure
  // shown. With nothing picked it only closes.
  const doShare = useCallback(async () => {
    if (await doGrant()) onClose();
  }, [doGrant, onClose]);

  // WHY the node is public, said in the reach line and acted on in the rows:
  // every literal `everyone` line (here, or in a parent) is the Everyone row's
  // source; every public plugin principal granted read is that plugin's
  // row. The line only describes — one mechanism removes, and it is the
  // same one for every principal.
  const publicReasons = [
    ...(lookupSources(data?.sources, 'r:everyone')?.read ?? []).map((s) =>
      s.kind === 'direct' ? 'granted here' : `inherited from ${folderLabel((s as { path: string }).path)}`,
    ),
    ...(data?.readers.publicVia ?? []).map((token) => {
      const parsed = parsePluginPrincipalToken(token);
      return `through ${parsed ? pluginPrincipalLabel(parsed.plugin, parsed.verb) : token}`;
    }),
  ];

  // The item's reach, in one line: the only place the sheet says whether it is
  // restricted or public. A statement, not a control — each public reason is a
  // grant with a row below, and the row is where it is removed.
  const reachLine = data ? (
    <p className="mt-2 flex items-start gap-1.5 text-detail text-ink-muted">
      {data.readers.restricted ? (
        <Lock size={13} aria-hidden className="mt-0.5 shrink-0" />
      ) : (
        <Globe size={13} aria-hidden className="mt-0.5 shrink-0 text-ok" />
      )}
      <span className="min-w-0">
        {data.readers.restricted
          ? 'Restricted: only the people below can open it'
          : `Public: anyone signed in can read it${
              publicReasons.length > 0 ? ` — ${publicReasons.join(', ')}` : ''
            }. Editing needs access.`}
      </span>
    </p>
  ) : null;

  /**
   * Apply a whole verb set to one existing row — the single action behind every
   * item of a row's menu, including Deny (`picked: null`).
   *
   * The user states the set they want; the dialog writes the DIFFERENCE between
   * that and what the principal effectively has here, with no prompt in between:
   *
   *   - a verb the set drops, held only through an entry on this target → revoke
   *     it here (there is nothing left to shadow once it is gone);
   *   - a verb the set drops that a PARENT still grants → a verb-scoped `deny` on
   *     this target, which is what "restrict just this folder" always wrote, now
   *     written straight from the row;
   *   - a verb the set adds that is denied here → lift that denial, which alone
   *     may restore it from the parent;
   *   - a verb the set adds that nothing confers → grant it here.
   *
   * Order is broadest-verb-first for both halves; see {@link VERBS_BROADEST_FIRST}
   * for why neither half is safe in the other order. Each call answers with the
   * server's fresh view, and the next step re-reads the row from it rather than
   * from a predicted state — so a partial failure leaves the sheet showing what
   * actually landed, and the steps already applied stand.
   */
  const doApplyVerbSet = useCallback(
    async (row: PrincipalRow, picked: VerbPick | null) => {
      if (!workspaceId || repoRelative === null) return;
      // The menu stays OPEN across the writes, as the per-verb checklist did:
      // its items freeze on `busy`, and when the fresh view lands they re-render
      // showing the set that actually took — including, per verb, "from <parent>"
      // or "restricted here". Closing it would hide exactly that answer.
      setBusy(true);
      setMutateError(null);
      const base = { path: entry.relativePath, kind: targetKind, principal: row.principal };
      let latest = data;
      /** The row as the LATEST server response describes it — never a guess. */
      const current = (): PrincipalRow | undefined =>
        buildRows(latest, myEmail).find((r) => r.key === row.key);
      const step = async (send: () => Promise<AccessResponse>) => {
        latest = await send();
        setData(latest);
      };
      try {
        // Deny is the whole-principal case and the server does it in one write:
        // `deny-here` with no verb strips every local grant and denies all four,
        // read included.
        if (picked === null) {
          await step(() => revokeAccess(workspaceId, { ...base, mode: 'deny-here' }));
          return;
        }

        // ---- lower: what the set drops -------------------------------------
        // Only a verb the pick states as OFF is dropped; one it leaves out is
        // left to the file (see `VerbPick`).
        for (const verb of VERBS_BROADEST_FIRST) {
          if (picked[VERB_TO_KEY[verb]] !== false) continue;
          const now = current();
          if (!now?.verbs[VERB_TO_KEY[verb]]) continue; // already gone
          const src = now.sources?.[verb] ?? [];
          // Purely local → a plain revoke is enough and leaves no `deny` line
          // behind to explain later. Anything else (inherited, or conferred with
          // no entry of its own) needs the denial: removing what is not written
          // here cannot take it away.
          const localOnly = src.length > 0 && src.every((s) => s.kind === 'direct');
          await step(() =>
            revokeAccess(
              workspaceId,
              localOnly ? { ...base, verb } : { ...base, mode: 'deny-here', verb },
            ),
          );
          // A local grant that turned out to be doubled by a parent: the revoke
          // landed, the verb survived it. Finish the job with the denial rather
          // than leave a half-applied set behind.
          if (localOnly && current()?.verbs[VERB_TO_KEY[verb]]) {
            await step(() => revokeAccess(workspaceId, { ...base, mode: 'deny-here', verb }));
          }
        }

        // ---- raise: lift the restrictions the new set no longer needs ------
        for (const verb of VERBS_BROADEST_FIRST) {
          if (!picked[VERB_TO_KEY[verb]]) continue;
          if (!(current()?.denials?.[verb] ?? []).some((s) => s.kind === 'direct')) continue;
          await step(() => revokeAccess(workspaceId, { ...base, verb }));
        }

        // ---- raise: grant what still nothing confers -----------------------
        // `minimalGrantVerbs` already drops the verbs the set's own higher ones
        // confer, so this writes at most two lines (a tier, plus download) and
        // never a redundant `read:` under a grant that carries read anyway.
        for (const verb of minimalGrantVerbs(picked)) {
          if (current()?.verbs[VERB_TO_KEY[verb]]) continue;
          await step(() => grantAccess(workspaceId, { ...base, verb }));
        }
      } catch (err) {
        setMutateError(err instanceof Error ? err.message : String(err));
        reload(); // re-sync on whatever the server actually holds now
      } finally {
        setBusy(false);
        // Wherever the writes left the row, keep it in view — from the latest
        // response, so a partial failure reveals where it actually is.
        revealRow(current());
      }
    },
    [workspaceId, repoRelative, entry.relativePath, targetKind, data, myEmail, reload, revealRow],
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
          // GRANT ancestors only. The dialog's offer is "remove their access
          // from <folder>"; an ancestor that denies holds no access to remove,
          // and acting there would strip that folder's restriction instead. A
          // row whose only ancestor entry is a denial falls to the no-ancestor
          // branch, which offers restricting here and nothing else.
          ancestors: row.grantAncestors,
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
        // If a parent still grants them something, the row has just moved into
        // that folder's collapsed section: keep it on screen (the prompt below
        // may be declined, and the person must not look removed when it is).
        revealRow(buildRows(res, myEmail).find((r) => r.key === row.key));
        // The direct entry was removed, but the FRESH view may still list this
        // principal with only `ancestor` source(s) — i.e. they're still inherited
        // from a parent. Open "Remove from parent?" so the one Remove click can
        // finish the job instead of leaving a row that reappears as inherited (a
        // silent half-removal). We read the just-revoked row's post-revoke sources
        // straight from the response, so it reflects the real current tree.
        //
        // GRANTS, deliberately — `res.denials` is not consulted. A parent that
        // still DENIES this principal is not unfinished business: the removal
        // already left them with nothing here, and chaining to that folder would
        // offer to delete its restriction.
        const ancestors = ancestorPaths(lookupSources(res.sources, row.key));
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
            ancestors: ancestorPaths(inherited.sources),
          });
        } else {
          setMutateError(err instanceof Error ? err.message : String(err));
          reload(); // re-sync the row state after a refused/rolled-back revoke
        }
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, repoRelative, entry.relativePath, targetKind, reload, myEmail, revealRow],
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

  // Every managed row ends in the same two slots: the verb control, then
  // Remove. A row with nothing removable here (a role or policy grant) keeps
  // the slot empty, so the verb control still lines up with its neighbours'.
  //
  // The accessible names are the ones these actions had before they shared a
  // slot: on a direct grant this is the old dropdown item "Remove access", on an
  // inherited grant the old "Remove" button. The name still contains the visible
  // word, so voice control ("click Remove") reaches both.
  const removeSlot = (p: PrincipalRow | null) => (
    <span className="flex w-16 shrink-0 justify-end">
      {p && (
        <Button
          variant="danger"
          size="tiny"
          disabled={busy}
          aria-label={p.manage === 'direct' ? 'Remove access' : undefined}
          onClick={() => doRevoke(p)}
        >
          Remove
        </Button>
      )}
    </span>
  );

  // One grantee row. Direct rows get the inline verb editor and a Remove that
  // revokes in place; inherited rows are read-only with a Remove that opens the
  // cascade flow; external rows are read-only with no action.
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
            {labelInitials(p.label)}
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
            {/* Granted, but nobody has signed in as this address yet. Beside
                the name, where the chip put it before the grant was saved —
                and gone by itself once they do sign in. */}
            {p.kind === 'user' && p.hasAccount === false && <NoAccountNote />}
            {p.kind !== 'user' && (
              // The same chip vocabulary as the suggest menu's trailing tags:
              // a role is a capability, a group is an audience — badge which.
              <Badge
                tone="outline"
                size="xs"
                className="shrink-0 uppercase"
                title={PRINCIPAL_KIND_HELP[p.kind]}
                aria-description={PRINCIPAL_KIND_HELP[p.kind]}
              >
                {p.kind === 'group' ? 'Group' : p.kind === 'plugin' ? 'Plugin' : 'Role'}
              </Badge>
            )}
          </div>
          {p.sub && <div className="truncate text-detail text-ink-muted">{p.sub}</div>}
        </div>
        {canManage ? (
          // ONE set of controls for every row the caller can manage — direct,
          // inherited or external alike. An inherited row used to be read-only
          // text here, which made "give this person less than the parent does" a
          // thing the sheet could describe but not do; the menu below does it, by
          // writing the restriction in the background.
          <div className="ml-auto flex max-w-full shrink-0 items-center gap-2">
            {p.manage === 'inherited' && (
              // Leaf folder name only (full path on hover) — where the entries
              // naming this principal live, when none of them is here.
              <span
                className="min-w-0 max-w-40 truncate text-detail italic text-ink-faint"
                title={p.ancestors.map(folderPath).join(', ')}
              >
                via {p.ancestors.map(folderLabel).join(', ')}
              </span>
            )}
            {/* Its own box: the menu anchors to its DOM parent, which must be
                the trigger alone, not the trigger and Remove together. */}
            <div>
              {/* Not `disabled={busy}`: the menu's items freeze while a grant or
                  revoke is in flight, and this button only opens or closes the
                  menu. Disabled, it could not take focus back on Escape
                  (`.focus()` on a disabled button is a no-op), and focus fell to
                  `document`. */}
              <Button
                ref={openRowKey === p.key ? openRowTriggerRef : undefined}
                variant="quiet"
                size="sm"
                onClick={() => setOpenRowKey((k) => (k === p.key ? null : p.key))}
                trailingIcon={<ChevronDown size={14} />}
              >
                {rowSummary(p)}
              </Button>
              {openRowKey === p.key && (
                <AnchoredMenu
                  onDismiss={() => setOpenRowKey(null)}
                  triggerRef={openRowTriggerRef}
                  // Sized to the items, not the trigger: a row that reads
                  // "Can read" opens a narrow panel, and its items carry
                  // notes ("from the whole workspace") that would otherwise
                  // squeeze the label itself down to "C…".
                  width="content"
                >
                  {/* Everyone is public READ only (the grant route refuses the
                      rest), so its row offers exactly the verb it can hold —
                      plus Deny, which takes even that away. */}
                  {(isEveryoneRole(p.principal) ? (['Can read'] as Role[]) : MENU_ROLES).map(
                    (role, i) => {
                      const checked = p.verbs[ROLE_TO_KEY[role]];
                      const note = verbNote(p, ROLE_TO_VERB[role]);
                      // Where a click on this item takes the row; null means
                      // nowhere from here, and the item says so by being off.
                      const next = nextVerbSet(p.verbs, role);
                      return (
                        // A Fragment, not a wrapper div: the items must stay
                        // DIRECT children of the panel, which is the box the
                        // menu measures and the keyboard walks.
                        <Fragment key={role}>
                          {/* Download is its own axis, not a lower tier — the
                              rule the separator has always drawn. */}
                          {role === 'Can download' && i > 0 && (
                            <div className="my-1 border-t border-line" />
                          )}
                          <MenuItem
                            disabled={busy || next === null}
                            active={checked}
                            aria-pressed={checked}
                            // The note is the row's own explanation, not part of
                            // what the item DOES: keep it out of the name ("Can
                            // read"), and give it to assistive tech as the
                            // description it is.
                            aria-description={note}
                            onClick={() => next && doApplyVerbSet(p, next)}
                            trailing={
                              <span className="flex items-center gap-1.5">
                                {note && (
                                  // The note is what gives way when the panel
                                  // is at its cap, never the label: bounded and
                                  // truncated, with the full text on hover.
                                  <span
                                    aria-hidden
                                    title={note}
                                    className="max-w-44 truncate text-meta text-ink-faint"
                                  >
                                    {note}
                                  </span>
                                )}
                                {checked && <Check size={14} className="text-accent" />}
                              </span>
                            }
                          >
                            {role}
                          </MenuItem>
                        </Fragment>
                      );
                    },
                  )}
                  <div className="my-1 border-t border-line" />
                  {/* Last, and the only destructive item: denies every verb here,
                      read included. The row stays — the block is a rule about
                      this person on this target, and this menu is where it is
                      lifted again. */}
                  <MenuItem
                    tone="danger"
                    disabled={busy}
                    active={p.deniedHere}
                    aria-description={`Block ${p.label} on this ${targetKind}, whatever a parent folder grants`}
                    onClick={() => doApplyVerbSet(p, null)}
                    trailing={p.deniedHere ? <Check size={14} className="text-danger" /> : undefined}
                  >
                    Deny
                  </MenuItem>
                </AnchoredMenu>
              )}
            </div>
            {/* An external row has no entry here to remove — the verb menu can
                still write one (a denial), but Remove would have nothing to act
                on, so the slot stays empty and the row still lines up. */}
            {removeSlot(p.manage === 'external' ? null : p)}
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
          // One primary action, named for what it will do: Share while
          // anything is picked, Done when there is nothing to grant.
          pickedChips.length > 0 ? (
            <Button
              variant="primary"
              size="sm"
              disabled={grantVerbs.length === 0 || busy}
              onClick={doShare}
              leadingIcon={busy ? <Loader2 size={14} className="animate-spin" /> : undefined}
            >
              Share
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={onClose}>
              Done
            </Button>
          )
        }
      >
        <p className="truncate text-detail text-ink-muted" title={entry.relativePath}>
          {entry.name}
        </p>

        {proposal && (
          <Banner tone="neutral" role="status" className="mt-3">
            {`You're editing access on change request #${proposal.number}. It takes effect when the request merges.`}
          </Banner>
        )}

        {governed && canManage && (
          <div className="mt-3">
            {/* `items-start`, not `items-stretch`: the verb button is `rounded-full`,
                so stretching it to match the chip box turned it into a pill the
                height of the box the moment a chip wrapped onto a second line.
                `flex-wrap` lets it drop below the box rather than crushing it. */}
            <div className="relative flex flex-wrap items-start gap-1.5">
              <div className="relative min-w-48 flex-1">
                {/* A TextField that grew chips: same border, radius and focus
                    treatment as the primitive, wrapped so the chips can wrap. */}
                <div className="flex w-full flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1 focus-within:border-transparent focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-accent">
                  {pickedChips.map((c) => {
                    const label = principalLabel(c);
                    // Nobody has signed in as this address — say so, and grant
                    // it anyway. Only an answer that ruled on this exact
                    // address earns the note (see `lacksAccount`); until one
                    // arrives the chip is simply unlabelled, never guessed at.
                    const noAccount = c.kind === 'user' && lacksAccount(c.email);
                    return (
                      // `max-w-full` bounds the chip by the field it sits in, so a
                      // long email can never push its own border past the box;
                      // `min-w-0` lets the label inside it actually shrink (a flex
                      // item's automatic minimum is its content, ellipsis or not).
                      <span
                        key={principalKey(c)}
                        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm bg-sunken px-2 py-0.5 text-detail text-ink"
                      >
                        {/* The label is the only part that gives way — it
                            truncates and carries the full name as its tooltip. */}
                        <span className="min-w-0 truncate" title={label}>
                          {label}
                        </span>
                        {noAccount && <NoAccountNote />}
                        <button
                          type="button"
                          onClick={() => removeChip(c)}
                          // `shrink-0`: the remove control stays whole and visible
                          // at the end of the chip however long the label is.
                          className="shrink-0 rounded-xs text-ink-faint hover:text-danger"
                          aria-label={`Remove ${label}`}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    );
                  })}
                  <input
                    ref={queryInputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && addPending) {
                        e.preventDefault();
                        addChip(addPending);
                      }
                    }}
                    placeholder={pickedChips.length ? '' : 'Add people, groups, roles or plugins…'}
                    className="min-w-32 flex-1 bg-transparent px-1 py-1 text-ui text-ink placeholder:text-ink-faint focus:outline-none"
                  />
                </div>
                {/* Defensive `?? []` on every field: a suggest response missing
                    `roles` or `groups` (version skew) must degrade to an empty
                    section, never a crash. Groups lead — they are the audience
                    concept grants are meant for; roles remain grantable below. */}
                {query.trim() && offered && offersAnything && (
                  <AnchoredMenu width="anchor" align="left" className="max-h-56 overflow-auto">
                    {offered.groups.map((g) => (
                      <MenuItem
                        key={`grp:${g}`}
                        onClick={() => addChip({ kind: 'group', group: g })}
                        trailing={
                          <span
                              className="text-label uppercase text-ink-faint"
                              title={PRINCIPAL_KIND_HELP.group}
                              aria-description={PRINCIPAL_KIND_HELP.group}
                            >
                              group
                            </span>
                        }
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-label font-bold text-ink-muted">
                          {labelInitials(g)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{g}</span>
                      </MenuItem>
                    ))}
                    {offered.roles.map((g) => (
                      <MenuItem
                        key={`g:${g}`}
                        onClick={() => addChip({ kind: 'role', role: g })}
                        trailing={
                          <span
                              className="text-label uppercase text-ink-faint"
                              title={PRINCIPAL_KIND_HELP.role}
                              aria-description={PRINCIPAL_KIND_HELP.role}
                            >
                              role
                            </span>
                        }
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-label font-bold text-ink-muted">
                          {labelInitials(g)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{g}</span>
                      </MenuItem>
                    ))}
                    {/* A plugin is three grantees — its readers, its writers, its
                        owners — each following the plugin's own roster live. */}
                    {offered.plugins.map(({ name, verb }) => (
                        <MenuItem
                          key={`pl:${name}/${verb}`}
                          onClick={() => addChip({ kind: 'plugin', plugin: name, verb })}
                          trailing={
                            <span
                              className="text-label uppercase text-ink-faint"
                              title={PRINCIPAL_KIND_HELP.plugin}
                              aria-description={PRINCIPAL_KIND_HELP.plugin}
                            >
                              plugin
                            </span>
                          }
                        >
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-label font-bold text-ink-muted">
                            {labelInitials(name)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{pluginPrincipalLabel(name, verb)}</span>
                        </MenuItem>
                    ))}
                    {offered.people.map((p) => {
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

              {/* People, groups, roles and plugins are the words the field and
                  its suggestions use; this says what each one is. */}
              <div className="flex h-8 shrink-0 items-center">
                <IconButton
                  ref={kindHelpTriggerRef}
                  aria-label="What can I share with?"
                  aria-expanded={kindHelpOpen}
                  active={kindHelpOpen}
                  onClick={() => setKindHelpOpen((o) => !o)}
                >
                  <CircleHelp size={16} />
                </IconButton>
                {kindHelpOpen && (
                  <AnchoredMenu
                    onDismiss={() => setKindHelpOpen(false)}
                    triggerRef={kindHelpTriggerRef}
                    width={320}
                  >
                    <ul aria-label="What can I share with?" className="flex flex-col gap-2 px-3 py-2">
                      {(['user', 'group', 'role', 'plugin'] as const).map((k) => (
                        <li key={k} className="text-detail leading-snug text-ink">
                          {PRINCIPAL_KIND_HELP[k]}
                        </li>
                      ))}
                    </ul>
                  </AnchoredMenu>
                )}
              </div>

              <div className="shrink-0">
                <Button
                  ref={verbTriggerRef}
                  variant="outline"
                  size="sm"
                  className="max-w-44"
                  onClick={() => setVerbOpen((o) => !o)}
                  trailingIcon={<ChevronDown size={14} className="shrink-0" />}
                >
                  <span className="truncate">{summarizeVerbs(effectiveNewVerbs)}</span>
                </Button>
                {verbOpen && (
                  <AnchoredMenu onDismiss={() => setVerbOpen(false)} triggerRef={verbTriggerRef}>
                    {TIER_ROLES.map((role) => {
                      const k = ROLE_TO_KEY[role];
                      const checked = effectiveNewVerbs[k];
                      const disabled =
                        (role === 'Can edit' && effectiveNewVerbs.owner) ||
                        (role === 'Can read' &&
                          (effectiveNewVerbs.owner ||
                            effectiveNewVerbs.write ||
                            effectiveNewVerbs.download));
                      return (
                        <MenuItem
                          key={role}
                          disabled={disabled}
                          active={checked}
                          aria-pressed={checked}
                          onClick={() =>
                            setNewVerbs((v) => {
                              const on = !v[k];
                              // Turning a tier OFF is "less than this", and less
                              // than edit is read, not nothing: the Read the tier
                              // implied stays selected in its own right. Read's
                              // own item is the one that takes read away.
                              return on || k === 'read'
                                ? { ...v, [k]: on }
                                : { ...v, [k]: false, read: true };
                            })
                          }
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
                      // Same rule as the tiers: unticking download keeps the
                      // read it implied.
                      onClick={() =>
                        setNewVerbs((v) =>
                          v.download ? { ...v, download: false, read: true } : { ...v, download: true },
                        )
                      }
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
            </div>
            {reachLine}
            {query.trim() && !addPending && !suggest?.peopleWithheld && (
              <p className="mt-1.5 text-detail text-ink-muted">
                Type a full email to add someone, or pick a group, role or plugin from the list.
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
            {/* No field to sit under: the reach line leads the sheet instead. */}
            {!canManage && reachLine}
            {folderGoverns ? (
              <>
                {/* No field and no rules here: say where the rules are, and
                    go there. Who can open the file is still worth knowing. */}
                <Banner tone="neutral" role="note" className="mt-3">
                  {folderGovernsAccessMessage(governingFolderLabel)}
                </Banner>
                {onManageAncestor && kbDirName && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    title={governingFolder || WHOLE_WORKSPACE}
                    onClick={() =>
                      onManageAncestor({
                        name: governingFolderLabel,
                        relativePath: governingFolder ? `${kbDirName}/${governingFolder}` : kbDirName,
                        type: 'directory',
                      })
                    }
                  >
                    {`Manage access on ${governingFolderLabel}`}
                  </Button>
                )}
                <h3 className="mb-1 mt-4 flex items-baseline gap-2 text-label uppercase text-ink-faint">
                  Who can open it
                  {readerRows.length > 0 && (
                    <span className="text-meta normal-case tabular-nums">{readerRows.length}</span>
                  )}
                </h3>
                {readerRows.length === 0 ? (
                  <p className="py-2 text-ui text-ink-muted">No one is named here.</p>
                ) : (
                  readerRows.map(renderRow)
                )}
              </>
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
              </>
            )}
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
            confirmRemove.ancestors.length === 1 && isRootAccessMd(confirmRemove.ancestors[0])
              ? `Remove from ${WHOLE_WORKSPACE}?`
              : confirmRemove.ancestors.length
                ? 'Remove from parent folder?'
                : 'Restrict access here?'
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
