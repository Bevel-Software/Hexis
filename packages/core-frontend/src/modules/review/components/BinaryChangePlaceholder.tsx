import { FileQuestion } from 'lucide-react';
import type { FileDiffPayload } from '@bevel-software/platform-shared';

export function BinaryChangePlaceholder({ payload }: { payload: FileDiffPayload }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-ink-muted text-xs px-6 text-center">
      <FileQuestion size={32} className="text-ink-muted" />
      <div className="font-medium text-ink">Binary file. Preview not available</div>
      <div className="font-mono truncate max-w-full" title={payload.path}>
        {payload.path}
      </div>
      <div>Use Accept or Reject from the file list to decide.</div>
    </div>
  );
}
