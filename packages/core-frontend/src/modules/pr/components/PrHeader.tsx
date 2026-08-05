import { X, GitPullRequest } from 'lucide-react';
import type { PullRequestDetail } from '@bevel-software/platform-shared';
import { PrMergeButton } from './PrMergeButton';
import { PrCancelButton } from './PrCancelButton';
import { PrRefreshFromTargetButton } from './PrRefreshFromTargetButton';
import { PrHeaderOverflowMenu } from './PrHeaderOverflowMenu';

interface Props {
  detail: PullRequestDetail;
  /** Dismiss the viewer overlay. Does not change the change request's state. */
  onCloseViewer(): void;
  /** Fired when the change request transitions to a terminal state (applied or cancelled). */
  onResolved(): void;
  /** Fired when the change request's diff changes (refresh-from-target). */
  onRefreshed(): void;
}

export function PrHeader({ detail, onCloseViewer, onResolved, onRefreshed }: Props) {
  return (
    <div className="h-10 border-b border-line flex items-center px-3 gap-2 shrink-0">
      <GitPullRequest size={14} className="text-ink-muted shrink-0" />
      <span className="text-sm font-medium text-ink truncate min-w-0">
        #{detail.number} · {detail.title}
      </span>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <PrMergeButton detail={detail} onMerged={onResolved} compact />
        {detail.state === 'open' && (
          <PrHeaderOverflowMenu>
            <PrRefreshFromTargetButton detail={detail} onRefreshed={onRefreshed} />
            <PrCancelButton detail={detail} onCancelled={onResolved} />
          </PrHeaderOverflowMenu>
        )}
        <button
          type="button"
          onClick={onCloseViewer}
          className="p-1 rounded hover:bg-hover text-ink-muted hover:text-ink transition-colors"
          title="Close panel"
          aria-label="Close panel"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
