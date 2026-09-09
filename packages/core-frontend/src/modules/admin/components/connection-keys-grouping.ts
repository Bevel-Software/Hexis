import type { AdminConnectionKey } from '../services/connection-keys.api';

export interface AccountGroup {
  user: AdminConnectionKey['user'];
  keys: AdminConnectionKey[];
}

/**
 * One list from the server, grouped per account in the order the server
 * returned it (owner email). Within an account: live keys first, most
 * recently used at the top, so the row an admin is hunting for — the key
 * that is still being used — is never below the ones that are not.
 *
 * Lives beside {@link ConnectionKeysPage} rather than in it: a component
 * file that also exports a plain function breaks fast refresh.
 */
export function groupByAccount(
  keys: AdminConnectionKey[],
  includeRevoked: boolean,
): AccountGroup[] {
  const groups: AccountGroup[] = [];
  const byUser = new Map<string, AccountGroup>();
  for (const key of keys) {
    if (!includeRevoked && key.revokedAt !== null) continue;
    let group = byUser.get(key.user.id);
    if (!group) {
      group = { user: key.user, keys: [] };
      byUser.set(key.user.id, group);
      groups.push(group);
    }
    group.keys.push(key);
  }
  for (const group of groups) {
    group.keys.sort((a, b) => {
      const aRevoked = a.revokedAt !== null;
      const bRevoked = b.revokedAt !== null;
      if (aRevoked !== bRevoked) return aRevoked ? 1 : -1;
      const byUse = (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
      return byUse !== 0 ? byUse : b.createdAt - a.createdAt;
    });
  }
  return groups;
}
