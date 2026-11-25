import { VersionControlDomainError } from '../../shared/domain-errors.js';
import { sanitizedPath } from '../../shared/printable.js';

/**
 * Apply was refused by the approval gate while this request is still owed an
 * approval carry: the server moved the draft's head itself (the roles.yaml
 * restore, or an update from the target) and could not copy the approvals of
 * the files that commit left alone onto the new head. Some of the files the
 * gate waits on wait only on that copy, and the next read of the request
 * tries it again; but a file the head move changed genuinely needs approving
 * again, and this refusal cannot tell the two apart. So it says what happened
 * and names the files the gate waits on (`waitingPaths`), never that no file
 * needs approving. By path alone: the gate's own reasons name the approvers,
 * and this text is kept as the request's last refusal. The list in the text is
 * bounded, so the whole sentence fits in the stored refusal, and each path
 * is escaped (`sanitizedPath`), so a name cannot break the line. Nothing was
 * applied. 503: the copy is the server's fault and temporary. Not
 * `mergeBlockedReasons`: that is the gate's own refusal shape.
 */
export class ApprovalCarryPendingError extends VersionControlDomainError {
  readonly kind = 'approval-carry-pending' as const;
  /** How much of the message the listed paths may take, so the whole of it fits the stored refusal. */
  static readonly LISTED_PATHS_MAX_CHARS = 400;
  constructor(waitingPaths: readonly string[] = []) {
    super(
      'The server updated this draft while applying it and could not yet carry the approvals already given over to the updated draft, so nothing was applied. ' +
        'Applying again tries once more to carry over the approvals of files the update left alone. ' +
        (waitingPaths.length > 0
          ? `Approval is still awaited on ${listedPaths(waitingPaths.map(sanitizedPath), ApprovalCarryPendingError.LISTED_PATHS_MAX_CHARS)}; any of those the update changed needs approving again.`
          : 'A file the update changed needs approving again.'),
      503,
      { kind: 'approval-carry-pending', retryable: true, ...(waitingPaths.length > 0 ? { waitingPaths: [...waitingPaths] } : {}) },
    );
    this.name = 'ApprovalCarryPendingError';
  }
}

/** `a, b and 3 more files`: as many paths as fit in `maxChars`, then a count of the rest. */
function listedPaths(paths: readonly string[], maxChars: number): string {
  const shown: string[] = [];
  let used = 0;
  for (const p of paths) {
    if (used + p.length + 2 > maxChars) break;
    shown.push(p);
    used += p.length + 2;
  }
  const rest = paths.length - shown.length;
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  if (shown.length === 0) return files(rest);
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}
