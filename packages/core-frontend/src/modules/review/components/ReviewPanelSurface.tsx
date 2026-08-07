import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { useReview } from '../state/review.context';
import { ReviewPanel } from './ReviewPanel';

/**
 * The floating agent-review surface the FileViewer mounts. Registered via the
 * app registry's `fileViewerPanels` (enterprise) instead of being hard-mounted
 * in the FileViewer, so the core viewer has no dependency on the review
 * module. Rendered inside the FileViewer's relative container, so the
 * absolutely-positioned badge/panel anchor exactly as before.
 *
 * Two separate concerns, deliberately NOT fused into one boolean:
 *   - `hasPendingReview` (the fact): a session exists. Drives the passive
 *     review badge (and, over in FileViewer, suppresses the legacy
 *     single-file Accept/Reject banner so the two review UIs don't compete).
 *   - `reviewPanelOpen` (the intent): the user has opened the panel. The
 *     panel only mounts when this is true. It never auto-opens just because
 *     changes exist — that's what kept this feature blocking the whole app.
 * Keeping these split is what lets a later step add "auto-open only for the
 * user who ran the agent" as a one-line tweak to the open condition.
 */
export function ReviewPanelSurface() {
  const review = useReview();
  const hasPendingReview = !!review.session && review.session.changes.length > 0;
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);

  // Reset intent when the changes clear, so the NEXT batch of agent changes
  // starts as a badge again rather than auto-reopening a stale-open panel.
  useEffect(() => {
    if (!hasPendingReview) setReviewPanelOpen(false);
  }, [hasPendingReview]);

  if (!hasPendingReview) return null;

  return reviewPanelOpen ? (
    <ReviewPanel onClose={() => setReviewPanelOpen(false)} />
  ) : (
    <button
      type="button"
      onClick={() => setReviewPanelOpen(true)}
      className="absolute bottom-4 right-4 z-20 flex items-center gap-2 px-3 py-2 rounded-full shadow-lg bg-ok hover:bg-ok/90 text-white text-xs font-medium"
      title="Review the agent's pending changes"
    >
      <Eye size={14} />
      Review agent changes
      <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-white/20 text-[11px]">
        {review.session!.changes.length}
      </span>
    </button>
  );
}
