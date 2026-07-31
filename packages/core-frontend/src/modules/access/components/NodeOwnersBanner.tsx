import { Users } from 'lucide-react';
import type { AccessEligible } from '../api';
import { formatEligible } from '../hooks/useFileAccess';

interface Props {
  owners: AccessEligible;
}

/**
 * A subtle line above the editor naming the file's owners — the people to
 * contact for more information about the node. Owners come from the `owner:`
 * lists in the access tree; they also hold write + approval rights, but this
 * banner is purely informational. Render only when there is at least one
 * owner.
 */
export function NodeOwnersBanner({ owners }: Props) {
  if (owners.roles.length === 0 && owners.users.length === 0) return null;
  const summary = formatEligible(owners);
  return (
    <div
      role="note"
      className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border-b border-slate-200 text-xs text-slate-600 shrink-0"
    >
      <Users size={13} className="shrink-0 text-slate-500" />
      <span className="flex-1">
        Owners — contact for more information: <span className="font-medium">{summary}</span>
      </span>
    </div>
  );
}
