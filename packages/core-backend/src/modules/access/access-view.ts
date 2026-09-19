import type {
  AccessDecisionSource,
  AccessTargetKind,
  DenialSources,
  GrantSource,
  GrantSources,
  IAccessControl,
  ResolvedPrincipal,
} from './access-control.interface.js';
import { canonicalRoleName, EVERYONE_CANONICAL, ROLE_TOKEN_PREFIX } from '../access-model/access-grammar.js';

type Verb = 'read' | 'write' | 'download' | 'owner';

/**
 * The resolved access view of one target, as the Manage access dialog reads it
 * (`GET /api/workspace/:id/access`): the caller's four verdicts, the eligible
 * principals per verb, and per-principal, per-verb grant sources. Shared by
 * that route and by `file_stat`'s access roster, so both list the same people.
 */
export async function resolveAccessView(
  accessControl: IAccessControl,
  workspaceId: string,
  repoRelTarget: string,
  userEmail: string,
  kind: AccessTargetKind,
) {
  const [canRead, canWrite, canDownload, canOwner, eligible, readers, owners, downloaders, deniedHere] =
    await Promise.all([
      accessControl.canRead(workspaceId, userEmail, repoRelTarget),
      accessControl.canWrite(workspaceId, userEmail, repoRelTarget),
      accessControl.canDownload(workspaceId, userEmail, repoRelTarget),
      accessControl.canOwner(workspaceId, userEmail, repoRelTarget),
      accessControl.eligibleWriters(workspaceId, repoRelTarget),
      accessControl.eligibleReaders(workspaceId, repoRelTarget),
      accessControl.eligibleOwners(workspaceId, repoRelTarget),
      accessControl.eligibleDownloaders(workspaceId, repoRelTarget),
      // The principals this target RESTRICTS. They hold nothing through it, so
      // no eligible list can carry them — yet the `deny` naming them is an entry
      // ON this target, and the dialog's row for it is where the restriction is
      // lifted. Unioned into the row set below alongside the holders.
      accessControl.locallyDeniedPrincipals?.(workspaceId, kind, repoRelTarget) ??
        Promise.resolve({ principals: [], users: [] }),
    ]);

  // Per-principal, per-verb origin (direct / ancestor — MECE over editable
  // files). Keyed `u:<email>` / `r:<role>` / `g:<group>` to match the
  // dialog's row keys, so each row can show where its access comes from and
  // which verbs are removable here. Groups get their OWN `g:` namespace: a
  // group and a role sharing a name are DIFFERENT principals (bare token vs
  // `role/<name>`), and one shared `r:` entry could only describe one of
  // them. Each kind resolves through the token spelling that IS that
  // principal — a group through its bare token (group-first precedence), a
  // role through its explicit `role/<name>` alias (correct whether or not a
  // group shadows the name; the built-in `everyone` keeps its bare spelling,
  // it has no alias). A row whose verbs resolve only via a
  // group/everyone/rescue has no source (the verb is absent) and renders
  // non-actionable. Built over the union of every principal in the four
  // eligible lists (kinded `principals`, with the name-only `roles` list as
  // the all-roles fallback) PLUS every principal this target DENIES — a
  // restriction is an entry here too, and a principal denied every verb
  // appears in no eligible list at all.
  const collectives = new Map<string, ResolvedPrincipal>();
  const addCollective = (p: ResolvedPrincipal) => {
    const key = rowKey(p);
    if (!collectives.has(key)) collectives.set(key, p);
  };
  for (const list of [eligible, readers, owners, downloaders]) {
    const kinded =
      list.principals ?? list.roles.map((name) => ({ name, kind: 'role' as const }));
    for (const p of kinded) addCollective(p);
  }
  for (const p of deniedHere.principals) addCollective(p);
  const userSet = new Map<string, { name: string; email: string }>();
  for (const u of [
    ...eligible.users,
    ...readers.users,
    ...owners.users,
    ...downloaders.users,
    ...deniedHere.users,
  ]) {
    // First writer wins, and the eligible lists come first deliberately: they
    // carry the roster's display name, while a deny line carries only whatever
    // the file spelled.
    if (!userSet.has(u.email.toLowerCase())) userSet.set(u.email.toLowerCase(), u);
  }
  const sources: Record<string, GrantSources> = {};
  // Denials ride in their OWN map, keyed the same way. A row reads both: the
  // grants say where each held verb comes from, the denials say why each missing
  // one is missing — "restricted here" as against never granted.
  const denials: Record<string, DenialSources> = {};
  await Promise.all([
    ...[...collectives.entries()].map(async ([key, p]) => {
      const token =
        p.kind === 'role' && canonicalRoleName(p.name) !== EVERYONE_CANONICAL
          ? `${ROLE_TOKEN_PREFIX}${p.name}`
          : p.name;
      const principal = { kind: 'role' as const, role: token };
      const [grants, denied] = await Promise.all([
        accessControl.grantSources(workspaceId, kind, repoRelTarget, principal),
        accessControl.denialSources?.(workspaceId, kind, repoRelTarget, principal) ??
          Promise.resolve({} as DenialSources),
      ]);
      sources[key] = grants;
      if (Object.keys(denied).length > 0) denials[key] = denied;
    }),
    ...[...userSet.values()].map(async (u) => {
      const principal = { kind: 'user' as const, email: u.email };
      const [grants, denied] = await Promise.all([
        accessControl.grantSources(workspaceId, kind, repoRelTarget, principal),
        accessControl.denialSources?.(workspaceId, kind, repoRelTarget, principal) ??
          Promise.resolve({} as DenialSources),
      ]);
      sources[`u:${u.email.toLowerCase()}`] = grants;
      if (Object.keys(denied).length > 0) denials[`u:${u.email.toLowerCase()}`] = denied;
    }),
  ]);

  return {
    canRead,
    canWrite,
    canDownload,
    canOwner,
    eligible,
    readers,
    owners,
    downloaders,
    sources,
    denials,
    deniedHere,
  };
}

export type AccessView = Awaited<ReturnType<typeof resolveAccessView>>;

/** The dialog's row key for a collective principal. */
function rowKey(p: ResolvedPrincipal): string {
  return `${p.kind === 'group' ? 'g' : p.kind === 'plugin' ? 'p' : 'r'}:${p.name.toLowerCase()}`;
}

/** One principal holding one verb, with every scope that names it for that verb, closest first. */
export interface RosterEntry {
  kind: 'group' | 'role' | 'plugin' | 'person';
  name: string;
  email?: string;
  /**
   * Where the grant is written, closest (effective) first. Empty when the
   * principal holds the verb without a line naming it here — the built-in
   * `everyone` made public by a plugin, for instance.
   */
  sources: AccessDecisionSource[];
}

export type AccessRoster = Record<Verb, RosterEntry[]>;

/** A grant source in the folder / frontmatter terms `file_stat` reports. */
function toDecisionSource(
  source: GrantSource,
  kind: AccessTargetKind,
  repoRelTarget: string,
): AccessDecisionSource {
  if (source.kind === 'ancestor') {
    const slash = source.path.lastIndexOf('/');
    return { kind: 'folder', path: slash === -1 ? '' : source.path.slice(0, slash), inherited: true };
  }
  return kind === 'folder'
    ? { kind: 'folder', path: repoRelTarget, inherited: false }
    : { kind: 'frontmatter', path: repoRelTarget, inherited: false };
}

/**
 * The principals per verb, as the Manage access dialog lists them — groups,
 * roles, plugin principals, then directly granted people — each with where its
 * grant comes from.
 */
export function accessRoster(view: AccessView, kind: AccessTargetKind, repoRelTarget: string): AccessRoster {
  const lists: Record<Verb, AccessView['eligible']> = {
    read: view.readers,
    write: view.eligible,
    download: view.downloaders,
    owner: view.owners,
  };
  const sourcesFor = (key: string, verb: Verb) =>
    (view.sources[key]?.[verb] ?? []).map((s) => toDecisionSource(s, kind, repoRelTarget));
  const roster = {} as AccessRoster;
  for (const verb of ['read', 'write', 'download', 'owner'] as const) {
    const list = lists[verb];
    const kinded = list.principals ?? list.roles.map((name) => ({ name, kind: 'role' as const }));
    roster[verb] = [
      ...kinded.map((p): RosterEntry => ({ kind: p.kind, name: p.name, sources: sourcesFor(rowKey(p), verb) })),
      ...list.users.map((u): RosterEntry => ({
        kind: 'person',
        name: u.name,
        email: u.email,
        sources: sourcesFor(`u:${u.email.toLowerCase()}`, verb),
      })),
    ];
  }
  return roster;
}
