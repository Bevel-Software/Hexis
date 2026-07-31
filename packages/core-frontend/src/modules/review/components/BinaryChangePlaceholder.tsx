import { FileQuestion } from 'lucide-react';
import type { FileDiffPayload } from '@bevel-software/shared';

export function BinaryChangePlaceholder({ payload }: { payload: FileDiffPayload }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-600 text-xs px-6 text-center">
      <FileQuestion size={32} className="text-slate-500" />
      <div className="font-medium text-slate-700">Binary file — preview not available</div>
      <div className="font-mono truncate max-w-full" title={payload.path}>
        {payload.path}
      </div>
      <div>Use Accept or Reject from the file list to decide.</div>
    </div>
  );
}
