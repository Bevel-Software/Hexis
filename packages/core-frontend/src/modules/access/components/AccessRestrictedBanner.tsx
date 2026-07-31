import { Lock } from 'lucide-react';
import type { AccessEligible } from '../api';
import { formatEligible } from '../hooks/useFileAccess';

interface Props {
  path: string;
  eligible: AccessEligible;
}

/**
 * Shown above the editor when the current user lacks `write` on the open
 * file. The editor itself goes read-only — this banner explains *why*
 * and names the people / roles who can change it.
 */
export function AccessRestrictedBanner({ path, eligible }: Props) {
  const summary = formatEligible(eligible);
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-1.5 bg-sunken border-b border-line text-xs text-ink shrink-0"
    >
      <Lock size={13} className="shrink-0 text-ink-muted" />
      <span className="flex-1">
        You don't have permission to edit{' '}
        <span className="font-mono text-ink">{path}</span>. Editing is restricted to{' '}
        <span className="font-medium">{summary}</span>. Ask one of them, or have the access
        rules for this folder broadened.
      </span>
    </div>
  );
}
