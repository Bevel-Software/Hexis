import { Check, FileEdit, FilePlus2, FileX2, ArrowRightLeft, FileQuestion, X } from 'lucide-react';
import type { FileApprovalState, PullRequestFile } from '@bevel-software/shared';
import { PrApprovalBadge } from './PrApprovalBadge';

interface Props {
  file: PullRequestFile;
  approval?: FileApprovalState;
  active: boolean;
  /** Email of the currently-authenticated user — determines whether to show Approve action. */
  currentUserEmail: string;
  /** Whether an approve/unapprove request is currently pending for this file. */
  busy: boolean;
  onSelect(): void;
  onApprove(): void;
  onUnapprove(): void;
}

function KindIcon({ status }: { status: PullRequestFile['status'] }) {
  const size = 13;
  switch (status) {
    case 'added': return <FilePlus2 size={size} className="text-emerald-600" />;
    case 'removed': return <FileX2 size={size} className="text-red-600" />;
    case 'renamed':
    case 'copied': return <ArrowRightLeft size={size} className="text-bevel" />;
    case 'modified':
    case 'changed': return <FileEdit size={size} className="text-amber-600" />;
    default: return <FileQuestion size={size} className="text-slate-600" />;
  }
}

export function PrFileRow({
  file,
  approval,
  active,
  currentUserEmail,
  busy,
  onSelect,
  onApprove,
  onUnapprove,
}: Props) {
  const { path, previousPath, status, additions, deletions, isBinary } = file;

  const normalizedEmail = currentUserEmail.trim().toLowerCase();
  // Authoritative gate: the backend pre-computes `viewerCanApprove` per file
  // by running the same access check `approveFile` does, so the UI only
  // surfaces the Approve button to users whose click would actually succeed.
  // Backwards-compat: older responses may not carry the field; fall back to
  // the direct-user-grant heuristic so the button doesn't disappear during
  // a rolling deploy.
  const eligibleEmails = (approval?.eligibleApprovers.users ?? []).map((u) =>
    u.email.trim().toLowerCase(),
  );
  const hasEligibleApprovers =
    (approval?.eligibleApprovers.roles.length ?? 0) > 0 ||
    (approval?.eligibleApprovers.users.length ?? 0) > 0;
  const isEligible =
    approval?.viewerCanApprove === true ||
    (approval?.viewerCanApprove === undefined && eligibleEmails.includes(normalizedEmail));
  // A current (non-stale) approval from THIS user is what the Unapprove button
  // toggles. Stale rows stay for audit but don't make the button a revoke.
  const hasOwnCurrentApproval = !!approval?.approvedBy.some(
    (a) => a.email.toLowerCase() === normalizedEmail && !a.isStale,
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors border ${
        active
          ? 'bg-slate-100 border-slate-300'
          : 'bg-white border-transparent hover:bg-slate-100 hover:border-slate-200'
      }`}
    >
      <KindIcon status={status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-xs text-slate-900 truncate">
          <span className="truncate font-mono" title={path}>{path}</span>
          <span className="text-[10px] uppercase tracking-wider text-slate-600 shrink-0">
            {status}
          </span>
          <PrApprovalBadge state={approval} />
        </div>
        <div className="flex items-center gap-2 text-[10px] text-slate-600 mt-0.5">
          {previousPath && (
            <span className="font-mono truncate" title={previousPath}>
              from {previousPath}
            </span>
          )}
          {isBinary ? (
            <span>binary</span>
          ) : (
            <>
              <span className="text-emerald-600">+{additions}</span>
              <span className="text-red-600">−{deletions}</span>
            </>
          )}
          {approval && approval.path.toLowerCase().endsWith('.md') && !hasEligibleApprovers && (
            <span className="text-red-600 shrink-0">no eligible approvers</span>
          )}
          {hasEligibleApprovers && !isEligible && (
            <span
              className="truncate text-slate-500 shrink-0"
              title={[
                ...approval!.eligibleApprovers.roles,
                ...approval!.eligibleApprovers.users.map((u) => u.email),
              ].join(', ')}
            >
              {(() => {
                const roles = approval!.eligibleApprovers.roles;
                const users = approval!.eligibleApprovers.users;
                if (roles.length && users.length) return `${roles[0]} +${users.length}`;
                if (roles.length) return roles.length === 1 ? roles[0] : `${roles[0]} +${roles.length - 1}`;
                const firstUser = users[0].name || users[0].email;
                return users.length === 1 ? firstUser : `${firstUser} +${users.length - 1}`;
              })()}
            </span>
          )}
        </div>
      </div>

      {isEligible && (
        <div className="flex items-center gap-1 shrink-0 opacity-70 group-hover:opacity-100">
          {hasOwnCurrentApproval ? (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onUnapprove();
              }}
              title="Withdraw your confirmation"
              aria-label="Withdraw your confirmation"
              className="p-1 rounded text-emerald-700 hover:text-red-700 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <X size={12} />
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onApprove();
              }}
              title="Confirm this file"
              aria-label="Confirm this file"
              className="p-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:bg-slate-100 disabled:text-slate-600 disabled:cursor-not-allowed"
            >
              <Check size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
