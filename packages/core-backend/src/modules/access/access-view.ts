import type {
  AccessDecisionSource,
  AccessTargetKind,
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
  const [canRead, canWrite, canDownload, canOwner, eligible, readers, owners, downloaders] =
    await Promise.all([
      accessControl.canRead(workspaceId, userEmail, repoRelTarget),
      accessControl.canWrite(workspaceId, userEmail, repoRelTarget),
      accessControl.canDownload(workspaceId, userEmail, repoRelTarget),
      accessControl.canOwner(workspaceId, userEmail, repoRelTarget),
      accessControl.eligibleWriters(workspaceId, repoRelTarget),
      accessControl.eligibleReaders(workspaceId, repoRelTarget),
      accessControl.eligibleOwners(workspaceId, repoRelTarget),
      accessControl.eligibleDownloaders(workspaceId, repoRelTarget),
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
  // the all-roles fallback).
  const collectives = new Map<string, ResolvedPrincipal>();
  for (const list of [eligible, readers, owners, downloaders]) {
    const kinded =
      list.principals ?? list.roles.map((name) => ({ name, kind: 'role' as const }));
    for (const p of kinded) {
      const key = rowKey(p);
      if (!collectives.has(key)) collectives.set(key, p);
    }
  }
  const userSet = new Map<string, { name: string; email: string }>();
  for (const u of [...eligible.users, ...readers.users, ...owners.users, ...downloaders.users]) {
    if (!userSet.has(u.email.toLowerCase())) userSet.set(u.email.toLowerCase(), u);
  }
  const sources: Record<string, GrantSources> = {};
  await Promise.all([
    ...[...collectives.entries()].map(async ([key, p]) => {
      const token =
        p.kind === 'role' && canonicalRoleName(p.name) !== EVERYONE_CANONICAL
          ? `${ROLE_TOKEN_PREFIX}${p.name}`
          : p.name;
      sources[key] = await accessControl.grantSources(workspaceId, kind, repoRelTarget, {
        kind: 'role',
        role: token,
      });
    }),
    ...[...userSet.values()].map(async (u) => {
      sources[`u:${u.email.toLowerCase()}`] = await accessControl.grantSources(
        workspaceId,
        kind,
        repoRelTarget,
        { kind: 'user', email: u.email },
      );
    }),
  ]);

  return { canRead, canWrite, canDownload, canOwner, eligible, readers, owners, downloaders, sources };
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

/**
 * A person named in an access list, plus whether an ACCOUNT exists for that
 * email yet — `false` until they sign in for the first time.
 *
 * Under single sign-on the account is created BY that first sign-in, so a
 * grant written ahead of time necessarily names an email with no account.
 * That is a real use case and stays allowed: nothing anywhere gates on this
 * flag. It exists so the share dialog can put a quiet "hasn't signed in yet"
 * beside the chip and the row, which is what makes a mistyped address
 * visible — and it turns true by itself the first time the person signs in,
 * so the note goes away without anyone editing the grant.
 */
export interface AccessViewUser {
  name: string;
  email: string;
  hasAccount: boolean;
}

type Labelled<L extends { users: { name: string; email: string }[] }> = Omit<L, 'users'> & {
  users: AccessViewUser[];
};

/** {@link AccessView} with every person carrying {@link AccessViewUser.hasAccount}. */
export type LabelledAccessView = Omit<
  AccessView,
  'eligible' | 'readers' | 'owners' | 'downloaders'
> & {
  eligible: Labelled<AccessView['eligible']>;
  readers: Labelled<AccessView['readers']>;
  owners: Labelled<AccessView['owners']>;
  downloaders: Labelled<AccessView['downloaders']>;
};

/**
 * Every distinct email the view names, canonical (trimmed + lowercased) — the
 * exact set to look accounts up by, and no more: the lookup is scoped to the
 * people this one view mentions rather than reading the whole users table.
 */
export function emailsInView(view: AccessView): string[] {
  return [
    ...new Set(
      [...view.eligible.users, ...view.readers.users, ...view.owners.users, ...view.downloaders.users]
        .map((u) => u.email.trim().toLowerCase())
        .filter((e) => e.length > 0),
    ),
  ];
}

/**
 * Mark each person in the view against `accountEmails` (canonical forms, as
 * {@link emailsInView} produces). Pure: the caller does the one database
 * lookup, this decides nothing but the label.
 */
export function labelAccountHolders(
  view: AccessView,
  accountEmails: ReadonlySet<string>,
): LabelledAccessView {
  const mark = <L extends { users: { name: string; email: string }[] }>(list: L): Labelled<L> => ({
    ...list,
    users: list.users.map((u) => ({
      ...u,
      hasAccount: accountEmails.has(u.email.trim().toLowerCase()),
    })),
  });
  return {
    ...view,
    eligible: mark(view.eligible),
    readers: mark(view.readers),
    owners: mark(view.owners),
    downloaders: mark(view.downloaders),
  };
}
