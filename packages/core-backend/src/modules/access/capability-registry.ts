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
 * A roles.yaml role NOT in this registry is a LEGACY people-set role from
 * before the split (e.g. "Product") — still valid as a grant principal, but
 * really a group; the roles admin surface flags it with a convert action.
 */

import { ADMIN_CANONICAL, canonicalRoleName } from './access-control.service.js';

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

export function capabilityRoleFor(roleName: string): CapabilityRole | null {
  const canonical = canonicalRoleName(roleName);
  return CAPABILITY_ROLES.find((r) => r.canonical === canonical) ?? null;
}

/** A roles.yaml role that is NOT a capability role — a pre-split people-set. */
export function isLegacyPeopleSetRole(roleName: string): boolean {
  return capabilityRoleFor(roleName) === null;
}
