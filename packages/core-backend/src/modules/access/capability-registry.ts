/**
 * Capability registry — the "what you can do in the app" half of the
 * roles/groups split.
 *
 * Roles are CODE-DEFINED capability bundles: the product decides which roles
 * exist and what each unlocks; admins assign them (to individuals, and — for
 * non-Admin roles — to groups via `group:` members in roles.yaml). Something
 * like "Developer" is not a role; that's a group.
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
   * Whether the role may be assigned to groups. False ONLY for Admin: letting
   * an IdP-synced group decide who is admin turns a misconfigured
   * provisioning connection into an admin-takeover/lockout vector, so Admin
   * stays individuals-only (also enforced at parse — see GROUP_REF_PREFIX).
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
    groupAssignable: false,
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
