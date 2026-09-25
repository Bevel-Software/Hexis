import type { AuditPrincipal } from '../services/audit.api';

export interface AccountGroup {
  user: AuditPrincipal['user'];
  principals: AuditPrincipal[];
}

/** The React key / disclosure id for one row — kinds share no id space, so both go in. */
export function principalKey(p: Pick<AuditPrincipal, 'kind' | 'id'>): string {
  return `${p.kind}:${p.id}`;
}

/**
 * One list from the server, grouped per account in the order the server
 * returned it (owner email; live before revoked, most recently used first).
 * Revoked rows are dropped unless asked for, and an account left with no
 * rows disappears with them.
 *
 * `query` narrows to accounts or rows whose name, email or label contains it
 * (case-insensitive) — the admin's "find that agent" box. A match on the
 * account keeps every row of it; a match on a row keeps just that row.
 *
 * Lives beside {@link AuditLogPage} rather than in it: a component file that
 * also exports a plain function breaks fast refresh.
 */
export function groupByAccount(
  principals: AuditPrincipal[],
  opts: { includeRevoked: boolean; query?: string },
): AccountGroup[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const groups: AccountGroup[] = [];
  const byUser = new Map<string, AccountGroup>();
  for (const p of principals) {
    if (!opts.includeRevoked && p.revokedAt !== null) continue;
    if (q) {
      const accountHit = p.user.name.toLowerCase().includes(q) || p.user.email.toLowerCase().includes(q);
      const rowHit = p.label.toLowerCase().includes(q);
      if (!accountHit && !rowHit) continue;
    }
    let group = byUser.get(p.user.id);
    if (!group) {
      group = { user: p.user, principals: [] };
      byUser.set(p.user.id, group);
      groups.push(group);
    }
    group.principals.push(p);
  }
  return groups;
}
