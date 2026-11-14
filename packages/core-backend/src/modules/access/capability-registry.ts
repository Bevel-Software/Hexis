/**
 * Capability registry — the "what you can do in the app" half of the
 * roles/groups split.
 *
 * Roles are CODE-DEFINED capability bundles: the product decides which roles
 * exist and what each unlocks; admins assign them (to individuals, and to
 * groups via `group:` members in roles.yaml — every role, Admin included,
 * kept safe by the parse-time at-least-one-direct-email invariant on Admin).
 * Something like "Developer" is not a role; that's a group.
 *
 * Adding a future role (the planned Plugin Creator) is a registry entry plus
 * capability gates at its feature surfaces — never a parser change: the
 * roles.yaml grammar, expansion, and admin surfaces are already
 * role-name-agnostic.
 *
 * An app built on core declares its own roles the same way, as data
 * ({@link AppRole}, passed in `ServerExtensions.appRoles`): the app gates on
 * them itself, and core lists them on App roles, lets admins assign them,
 * and never counts them as legacy. Core's own capabilities stay core's.
 *
 * A roles.yaml role NOT in this registry is a LEGACY people-set role from
 * before the split (e.g. "Product") — still valid as a grant principal, but
 * really a group; the roles admin surface flags it with a convert action.
 */

import { ADMIN_CANONICAL, canonicalRoleName, parseRolesYaml } from '../access-model/index.js';
import { emitRolesModel } from './roles-edit.js';

/** A capability an app surface gates on. Grow this union with the gates. */
export type Capability =
  | 'manage-deployment'
  | 'manage-accounts'
  | 'manage-roles'
  | 'manage-groups'
  | 'manage-directory';

export interface CapabilityRole {
  canonical: string;
  displayName: string;
  /** Admin-facing one-liner for the Roles page. */
  description: string;
  capabilities: readonly Capability[];
  /**
   * Whether the role may be assigned to groups. True for every role, Admin
   * included — with the parse-time invariant that Admin ALWAYS keeps at least
   * one direct email member (see `parseRolesYaml`), so a misconfigured or
   * unreachable directory can never leave the deployment without a
   * directory-independent admin.
   */
  groupAssignable: boolean;
}

export const CAPABILITY_ROLES: readonly CapabilityRole[] = [
  {
    canonical: ADMIN_CANONICAL,
    displayName: 'Admin',
    description:
      'Detailed configuration: deployment settings, user accounts, roles & groups, and the directory connection.',
    capabilities: [
      'manage-deployment',
      'manage-accounts',
      'manage-roles',
      'manage-groups',
      'manage-directory',
    ],
    groupAssignable: true,
  },
  // Planned next (lands with its feature gates, not before):
  // { canonical: 'plugin creator', displayName: 'Plugin Creator', … }
];

/**
 * A role an app built on core declares: what admins read about it on App
 * roles. What it unlocks is the app's own gate (core has no capability for
 * it), and every app role may be assigned to groups, as every core role may.
 */
export interface AppRole {
  displayName: string;
  /** Admin-facing one-liner for the App roles page. */
  description: string;
}

/**
 * Refuse, with the reason, an app's role list that roles.yaml could not hold:
 * a name the roles.yaml parser rejects (reserved, a principal prefix, a
 * colon), one that does not read back as written, or a name core or another
 * app role already has. Checked once, where the app's roles enter core (the
 * roles admin service's construction, at boot): the list is the app's code,
 * so a bad name is a defect that should stop the start, not a role that
 * looks assignable and fails on its first holder. Each name is judged by
 * the parser itself, on a roles.yaml that holds it with one member beside
 * a valid Admin.
 */
export function assertAppRoles(appRoles: readonly AppRole[]): void {
  const taken = new Set(CAPABILITY_ROLES.map((r) => r.canonical));
  for (const role of appRoles) {
    const displayName = role.displayName.trim();
    const canonical = canonicalRoleName(displayName);
    if (!canonical) throw new Error('an app role has an empty name');
    if (taken.has(canonical)) throw new Error(`app role "${displayName}" is already a role of this deployment`);
    taken.add(canonical);
    const candidate = emitRolesModel([
      { displayName: 'Admin', members: ['admin@example.com'] },
      { displayName, members: ['holder@example.com'] },
    ]);
    const parsed = parseRolesYaml(candidate);
    if (!parsed.ok) throw new Error(`app role "${displayName}" cannot be written to roles.yaml: ${parsed.errors.join('; ')}`);
    if (parsed.index.byCanonical.get(canonical)?.displayName !== displayName) {
      throw new Error(`app role "${displayName}" does not read back from roles.yaml as written`);
    }
  }
}

/**
 * Core's roles, then the app's: every role this deployment defines. The
 * app's list is checked by {@link assertAppRoles} where it enters core, so
 * each name here is distinct and one roles.yaml can hold.
 */
export function capabilityRoles(appRoles: readonly AppRole[] = []): readonly CapabilityRole[] {
  return [
    ...CAPABILITY_ROLES,
    ...appRoles.map((role) => ({
      canonical: canonicalRoleName(role.displayName),
      displayName: role.displayName.trim(),
      description: role.description,
      capabilities: [],
      groupAssignable: true,
    })),
  ];
}

export function capabilityRoleFor(roleName: string, appRoles: readonly AppRole[] = []): CapabilityRole | null {
  const canonical = canonicalRoleName(roleName);
  return capabilityRoles(appRoles).find((r) => r.canonical === canonical) ?? null;
}

/** A roles.yaml role that is NOT a capability role (core's or the app's) — a pre-split people-set. */
export function isLegacyPeopleSetRole(roleName: string, appRoles: readonly AppRole[] = []): boolean {
  return capabilityRoleFor(roleName, appRoles) === null;
}
