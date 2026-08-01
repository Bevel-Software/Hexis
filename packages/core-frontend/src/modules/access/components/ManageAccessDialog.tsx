import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Lock, Loader2, ChevronDown, Check, Globe } from 'lucide-react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useAuth } from '../../auth/state/auth.context';
import {
  fetchFileAccess,
  grantAccess,
  revokeAccess,
  suggestPrincipals,
  asInheritedError,
  type AccessResponse,
  type GrantVerb,
  type GrantSource,
  type GrantSources,
  type Principal,
  type SuggestResponse,
} from '../api';

interface Props {
  entry: FileTreeEntry;
  onClose: () => void;
  /**
   * The workspace (branch) whose access is read and edited. Defaults to the
   * ambient `WorkspaceContext` — which is what the file explorer wants, since
   * it edits the branch the user is looking at.
   *
   * The Library is the other case: its surfaces describe the DEFAULT branch
   * regardless of which branch happens to be open, so a group's access edit
   * has to be pinned to it. Without this the same click would splice
   * `access.md` on whatever branch the context last had open — a rule written
   * into a draft nobody merges, silently doing nothing.
   */
  workspaceId?: string;
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
  isRole: boolean;
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

const AVATAR_COLORS = ['#863bff', '#0ea5e9', '#16a34a', '#f59e0b', '#ec4899', '#7e14ff'];

function initials(label: string): string {
  const parts = label.replace(/[<>]/g, '').trim().split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

const EMAIL_RE = /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/;

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

/** The built-in `everyone` group — grantable as public READ only (see backend). */
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

/**
 * Google-Drive-style "Manage access" sheet. Reads the resolved access for a KB
 * path and lets anyone who can write the path's access config share it: add one
 * or more people/groups as chips and grant them a shared verb (Owner / Can edit /
 * Can read / Can download). Each existing grantee's verbs are editable inline via
 * a multi-select checklist (independent verbs); toggling a box grants or revokes
 * that single verb. Grants/revokes write the folder's `access.md` (folder target)
 * or the node's own frontmatter (file target) server-side and commit + push. When
 * the user can't write the access config, the add affordance is disabled and
 * names the owners to ask.
 */
export function ManageAccessDialog({ entry, onClose, workspaceId: workspaceIdProp }: Props) {
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    const touchRole = (role: string): PrincipalRow => {
      const key = `r:${role.toLowerCase()}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          label: role,
          isRole: true,
          isYou: false,
          principal: { kind: 'role', role },
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
        row = {
          key,
          label: u.name || u.email,
          sub: u.email,
          isRole: false,
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

    for (const r of data.owners.roles) touchRole(r).verbs.owner = true;
    for (const u of data.owners.users) touchUser(u).verbs.owner = true;
    for (const r of data.eligible.roles) touchRole(r).verbs.write = true;
    for (const u of data.eligible.users) touchUser(u).verbs.write = true;
    // Read membership is per-principal only for a restricted node. When
    // `restricted` is false, read is `everyone` and the reader lists are empty.
    if (data.readers.restricted) {
      for (const r of data.readers.roles) touchRole(r).verbs.read = true;
      for (const u of data.readers.users) touchUser(u).verbs.read = true;
    }
    for (const r of data.downloaders.roles) touchRole(r).verbs.download = true;
    for (const u of data.downloaders.users) touchUser(u).verbs.download = true;

    // Attach each row's per-verb source + manageability (direct / inherited /
    // external) from the resolver's `sources` map, keyed by the same row key.
    for (const row of rows.values()) {
      row.sources = data.sources?.[row.key];
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
  const [showInherited, setShowInherited] = useState(false);

  const governed = repoRelative !== null;
  // The dialog can mutate only if the current user can write this path's access
  // config — exactly what the backend gate enforces. `canWrite` on the path is
  // the same signal (folder access.md / node frontmatter both gate on write).
  const canManage = !!data?.canWrite;

  // Resolve the CURRENT typed query into a principal to append as a chip: an
  // exact group match or a free-typed email. (Suggestion clicks append directly.)
  const addPending: Principal | null = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const groupHit = suggest?.groups.find((g) => g.toLowerCase() === q.toLowerCase());
    if (groupHit) return { kind: 'role', role: groupHit };
    if (EMAIL_RE.test(q)) return { kind: 'user', email: q, displayName: q.split('@')[0] };
    return null;
  }, [query, suggest]);

  const principalKey = (p: Principal): string =>
    p.kind === 'role' ? `r:${p.role.toLowerCase()}` : `u:${p.email.toLowerCase()}`;

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
        const label = principal.kind === 'role' ? principal.role : principal.email;
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
          failures.push(`${label}: "Everyone" can only be granted read access — select "Can read".`);
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
  // flip optimistically); a refused revoke (e.g. last-owner) surfaces its message
  // and we re-sync.
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
          const key = principal.kind === 'role'
            ? `r:${principal.role.toLowerCase()}`
            : `u:${principal.email.toLowerCase()}`;
          const stillForVerb = res.sources?.[key]?.[grantVerb] ?? [];
          const ancestors = ancestorsFromSources({ [grantVerb]: stillForVerb });
          if (ancestors.length > 0) {
            const label =
              principal.kind === 'role' ? principal.role : principal.displayName || principal.email;
            setConfirmRemove({ principal, label, ancestors, verb: grantVerb });
          }
        }
      } catch (err) {
        // Unchecking a verb the principal holds via INHERITANCE (e.g. they're
        // direct on `download` but inherit `write`) can't be done in place — the
        // target splice no-ops and the route 409s. Convert that into the same
        // "Remove from parent?" flow a Remove uses, instead of a raw error toast.
        const inherited = asInheritedError(err);
        if (inherited) {
          const label =
            principal.kind === 'role' ? principal.role : principal.displayName || principal.email;
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
        const ancestors = ancestorsFromSources(res.sources?.[row.key]);
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
  // read-only with no action. `dense` trims the avatar/labels in the collapsed
  // inherited section so a deep folder chain doesn't overflow.
  const renderRow = (p: PrincipalRow) => (
    <div key={p.key} className="flex items-center gap-3 py-2 group">
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold text-white shrink-0"
        style={{ background: p.isRole ? '#64748b' : avatarColor(p.label) }}
      >
        {initials(p.label)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-ink font-medium truncate">
          {p.label}
          {p.isYou && <span className="text-ink-faint font-normal"> (you)</span>}
          {p.isRole && (
            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-ink-faint">role</span>
          )}
        </div>
        {p.sub && <div className="text-xs text-ink-muted truncate">{p.sub}</div>}
      </div>
      {canManage && p.manage === 'inherited' ? (
        // Inherited from a parent folder — read-only here. Leaf folder name only
        // (full path on hover); Remove opens the "Remove from parent?" flow.
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="text-xs text-ink-faint italic max-w-[10rem] truncate"
            title={p.ancestors.map(folderPath).join(', ')}
          >
            via {p.ancestors.map(folderLabel).join(', ')}
          </span>
          <span className="text-sm text-ink-faint">{summarizeVerbs(p.verbs)}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => doRevoke(p)}
            className="px-2 py-1 rounded text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed"
          >
            Remove
          </button>
        </div>
      ) : canManage && p.manage === 'external' ? (
        // No file-backed grant to remove here — managed elsewhere (a group's
        // membership, the everyone policy, or admin rescue).
        <span
          className="text-sm text-ink-faint shrink-0"
          title="Granted via a role or policy — manage it there"
        >
          {summarizeVerbs(p.verbs)}
        </span>
      ) : canManage ? (
        <div className="relative shrink-0">
          <button
            type="button"
            disabled={busy}
            onClick={() => setOpenRowKey((k) => (k === p.key ? null : p.key))}
            className="px-2 py-1 rounded text-sm text-ink-muted flex items-center gap-1 hover:bg-hover disabled:cursor-not-allowed"
          >
            {summarizeVerbs(p.verbs)}
            <ChevronDown size={14} />
          </button>
          {openRowKey === p.key && (
            <div className="absolute right-0 z-20 mt-1 bg-white border border-line rounded-lg shadow-lg w-44 py-1">
              {TIER_ROLES.map((role) => {
                const k = ROLE_TO_KEY[role];
                const checked = p.verbs[k];
                const disabled =
                  busy ||
                  (role === 'Can edit' && p.verbs.owner) ||
                  (role === 'Can read' && (p.verbs.owner || p.verbs.write));
                return (
                  <button
                    key={role}
                    type="button"
                    disabled={disabled}
                    onClick={() => doToggleVerb(p.principal, role, checked)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span className="w-4 h-4 border border-line-strong rounded flex items-center justify-center shrink-0">
                      {checked && <Check size={12} className="text-bevel" />}
                    </span>
                    <span className="flex-1 text-left">{role}</span>
                  </button>
                );
              })}
              <div className="border-t border-line my-1" />
              {(() => {
                const checked = p.verbs.download;
                const disabled = busy || p.verbs.owner;
                return (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => doToggleVerb(p.principal, 'Can download', checked)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span className="w-4 h-4 border border-line-strong rounded flex items-center justify-center shrink-0">
                      {checked && <Check size={12} className="text-bevel" />}
                    </span>
                    <span className="flex-1 text-left">Can download</span>
                  </button>
                );
              })()}
              <div className="border-t border-line my-1" />
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpenRowKey(null);
                  doRevoke(p);
                }}
                className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed"
              >
                Remove access
              </button>
            </div>
          )}
        </div>
      ) : (
        <span className="text-sm text-ink-muted shrink-0">{summarizeVerbs(p.verbs)}</span>
      )}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[70] bg-scrim flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-access-title"
        className="w-full max-w-[540px] max-h-[86vh] overflow-auto bg-white rounded-2xl shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-2">
          <div className="min-w-0">
            <h2 id="manage-access-title" className="text-lg font-bold text-ink">
              Manage access
            </h2>
            <div className="mt-0.5 text-sm text-ink-muted truncate" title={entry.relativePath}>
              {entry.name}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-hover text-ink-muted hover:text-ink shrink-0"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-6 pb-2">
          {governed && canManage && (
            <div className="my-3">
              <div className="flex gap-2 relative">
                <div className="flex-1 relative">
                  <div className="w-full border border-line rounded-lg px-2 py-1.5 flex flex-wrap items-center gap-1.5 focus-within:ring-2 focus-within:ring-bevel/40">
                    {pickedChips.map((c) => {
                      const label = c.kind === 'role' ? c.role : c.displayName || c.email;
                      return (
                        <span
                          key={principalKey(c)}
                          className="inline-flex items-center gap-1 bg-sunken text-ink rounded px-2 py-1 text-xs"
                        >
                          {label}
                          <button
                            type="button"
                            onClick={() => removeChip(c)}
                            className="text-ink-faint hover:text-red-600"
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
                      placeholder={pickedChips.length ? '' : 'Add people or roles…'}
                      className="flex-1 min-w-[8rem] px-1 py-1 text-sm focus:outline-none"
                    />
                  </div>
                  {query.trim() && suggest && (suggest.groups.length > 0 || suggest.people.length > 0) && (
                    <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-line rounded-lg shadow-lg max-h-56 overflow-auto">
                      {suggest.groups.map((g) => (
                        <button
                          key={`g:${g}`}
                          type="button"
                          onClick={() => addChip({ kind: 'role', role: g })}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-hover flex items-center gap-2"
                        >
                          <span className="w-6 h-6 rounded-full bg-ink-muted text-white text-[10px] flex items-center justify-center">
                            {initials(g)}
                          </span>
                          <span className="flex-1">{g}</span>
                          <span className="text-[10px] uppercase tracking-wide text-ink-faint">
                            role
                          </span>
                        </button>
                      ))}
                      {suggest.people.map((p) => (
                        <button
                          key={`p:${p.email}`}
                          type="button"
                          onClick={() => addChip({ kind: 'user', email: p.email, displayName: p.name })}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-hover flex items-center gap-2"
                        >
                          <span
                            className="w-6 h-6 rounded-full text-white text-[10px] flex items-center justify-center"
                            style={{ background: avatarColor(p.name || p.email) }}
                          >
                            {initials(p.name || p.email)}
                          </span>
                          <span className="flex-1 truncate">{p.name || p.email}</span>
                          <span className="text-xs text-ink-faint truncate">{p.email}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setVerbOpen((o) => !o)}
                    className="h-full px-3 rounded-lg border border-line text-sm text-ink flex items-center gap-1 hover:bg-hover max-w-[12rem]"
                  >
                    <span className="truncate">{summarizeVerbs(effectiveNewVerbs)}</span>
                    <ChevronDown size={14} className="shrink-0" />
                  </button>
                  {verbOpen && (
                    <div className="absolute right-0 z-10 mt-1 bg-white border border-line rounded-lg shadow-lg w-44 py-1">
                      {TIER_ROLES.map((role) => {
                        const k = ROLE_TO_KEY[role];
                        const checked = effectiveNewVerbs[k];
                        const disabled =
                          (role === 'Can edit' && effectiveNewVerbs.owner) ||
                          (role === 'Can read' && (effectiveNewVerbs.owner || effectiveNewVerbs.write));
                        return (
                          <button
                            key={role}
                            type="button"
                            disabled={disabled}
                            aria-pressed={checked}
                            onClick={() => setNewVerbs((v) => ({ ...v, [k]: !v[k] }))}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <span className="w-4 h-4 border border-line-strong rounded flex items-center justify-center shrink-0">
                              {checked && <Check size={12} className="text-bevel" />}
                            </span>
                            <span className="flex-1 text-left">{role}</span>
                          </button>
                        );
                      })}
                      <div className="border-t border-line my-1" />
                      <button
                        type="button"
                        disabled={effectiveNewVerbs.owner}
                        aria-pressed={effectiveNewVerbs.download}
                        onClick={() => setNewVerbs((v) => ({ ...v, download: !v.download }))}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="w-4 h-4 border border-line-strong rounded flex items-center justify-center shrink-0">
                          {effectiveNewVerbs.download && <Check size={12} className="text-bevel" />}
                        </span>
                        <span className="flex-1 text-left">Can download</span>
                      </button>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  disabled={pickedChips.length === 0 || grantVerbs.length === 0 || busy}
                  onClick={doGrant}
                  className="px-4 rounded-lg text-sm font-medium bg-bevel hover:bg-bevel-deep text-white disabled:bg-bevel/40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  {busy && <Loader2 size={14} className="animate-spin" />}
                  Share
                </button>
              </div>
              {query.trim() && !addPending && !suggest?.peopleWithheld && (
                <div className="mt-1.5 text-xs text-ink-muted">
                  Type a full email to add someone, or pick a role from the list.
                </div>
              )}
              {pickedChips.some(isEveryoneRole) && (
                <div className="mt-1.5 text-xs text-ink-muted">
                  “Everyone” makes this {targetKind} publicly readable — it can only be granted read access.
                </div>
              )}
              {mutateError && (
                <div className="mt-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {mutateError}
                </div>
              )}
            </div>
          )}

          {!governed ? (
            <div className="py-8 text-center text-sm text-ink-muted">
              This item isn't part of the knowledge base, so it isn't governed by access control.
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-ink-muted">
              <Loader2 size={16} className="animate-spin" /> Loading access…
            </div>
          ) : error ? (
            <div className="py-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3">
              Couldn't load access: {error}
            </div>
          ) : (
            <>
              {!canManage && (
                <div className="flex items-center gap-3 bg-bevel-soft rounded-lg px-3 py-2.5 mb-3 text-sm text-bevel-deep">
                  <span className="flex-1">
                    Only people with edit access can share this {targetKind}.
                    {ownerNames && <> Ask an owner: {ownerNames}.</>}
                  </span>
                </div>
              )}

              <div className="text-sm font-bold text-ink my-2">People with access</div>

              {data && !data.readers.restricted && (
                <div className="flex items-center gap-3 py-1.5">
                  <span className="w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center shrink-0">
                    <Globe size={16} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-ink">Anyone can read</div>
                    <div className="text-xs text-ink-muted">Public — every signed-in user can read this {targetKind}</div>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={removePublicRead}
                      className="text-xs text-ink-muted hover:text-red-600 disabled:opacity-50 px-2 py-1"
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}

              {directRows.length === 0 ? (
                <div className="text-sm text-ink-muted py-2">
                  {inheritedRows.length > 0
                    ? 'No one is granted directly here — everyone below inherits access from a parent folder.'
                    : 'No explicit grants at this path.'}
                </div>
              ) : (
                directRows.map(renderRow)
              )}

              {inheritedRows.length > 0 && (
                <div className="mt-3 border-t border-line pt-2">
                  <button
                    type="button"
                    onClick={() => setShowInherited((v) => !v)}
                    className="w-full flex items-center gap-1.5 py-1 text-sm font-medium text-ink-muted hover:text-ink"
                  >
                    <ChevronDown
                      size={14}
                      className={`transition-transform ${showInherited ? 'rotate-180' : ''}`}
                    />
                    Inherited access ({inheritedRows.length})
                    <span className="font-normal text-ink-faint">
                      — from parent folders &amp; roles
                    </span>
                  </button>
                  {showInherited && <div className="mt-1">{inheritedRows.map(renderRow)}</div>}
                </div>
              )}

              <div className="flex items-center gap-3 border-t border-line mt-4 pt-4">
                <div className="w-9 h-9 rounded-full bg-sunken text-ink-muted flex items-center justify-center shrink-0">
                  <Lock size={16} />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-ink">Restricted</div>
                  <div className="text-xs text-ink-muted">
                    Only people granted access can edit this item.
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-lg text-sm font-medium bg-bevel hover:bg-bevel-deep text-white"
          >
            Done
          </button>
        </div>
      </div>

      {confirmRemove && (
        <div
          className="fixed inset-0 z-[80] bg-scrim flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setConfirmRemove(null);
          }}
        >
          <div role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            {(() => {
              // When the flow was triggered by unchecking ONE verb, the whole
              // confirmation is scoped to it ("their EDIT access", "remove EDIT
              // from the parent"); otherwise it's the whole principal.
              const va = confirmRemove.verb ? `${VERB_NOUN[confirmRemove.verb]} access` : 'access';
              return (
                <>
                  <h3 className="text-lg font-semibold text-ink">
                    {confirmRemove.ancestors.length ? 'Remove from parent folder?' : 'Restrict access here?'}
                  </h3>
                  <p className="mt-2 text-sm text-ink-muted">
                    {confirmRemove.ancestors.length ? (
                      <>
                        {confirmRemove.label}'s {va} here is inherited from{' '}
                        <span className="font-medium" title={confirmRemove.ancestors.map(folderPath).join(', ')}>
                          {confirmRemove.ancestors.map(folderLabel).join(', ')}
                        </span>
                        . Remove their {va} from the parent — which also removes it from other items in
                        that folder — or restrict just this {targetKind} while leaving the parent grant
                        intact.
                      </>
                    ) : (
                      <>
                        {confirmRemove.label}'s {va} here comes from a role or policy, not a grant on
                        this {targetKind}. You can't remove it here — but you can restrict their {va} on
                        just this {targetKind} by adding a block.
                      </>
                    )}
                  </p>
                </>
              );
            })()}

            {mutateError && (
              <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {mutateError}
              </div>
            )}

            <div className="mt-5 flex flex-col gap-2">
              {confirmRemove.ancestors.length === 1 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => doRemoveFromParent(confirmRemove.principal, confirmRemove.ancestors[0], confirmRemove.verb)}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-bevel hover:bg-bevel-deep text-white disabled:bg-bevel/40 disabled:cursor-not-allowed"
                >
                  Remove from {folderLabel(confirmRemove.ancestors[0])}
                </button>
              )}
              {confirmRemove.ancestors.length > 1 && (
                <>
                  <div className="text-xs text-ink-muted">
                    Inherited from multiple folders — remove from one at a time:
                  </div>
                  {confirmRemove.ancestors.map((a) => (
                    <button
                      key={a}
                      type="button"
                      disabled={busy}
                      onClick={() => doRemoveFromParent(confirmRemove.principal, a, confirmRemove.verb)}
                      className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-bevel hover:bg-bevel-deep text-white disabled:bg-bevel/40 disabled:cursor-not-allowed"
                    >
                      Remove from {folderLabel(a)}
                    </button>
                  ))}
                </>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => doDenyHere(confirmRemove.principal, confirmRemove.verb)}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-medium border border-line-strong text-ink hover:bg-hover disabled:cursor-not-allowed"
              >
                Restrict just this {targetKind}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmRemove(null)}
                className="w-full px-4 py-2 rounded-lg text-sm text-ink-muted hover:bg-hover disabled:cursor-not-allowed"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
