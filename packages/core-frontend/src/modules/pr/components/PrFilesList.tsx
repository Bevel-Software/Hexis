import type { FileApprovalState, PullRequestFile } from '@bevel-software/shared';
import { PrFileRow } from './PrFileRow';

interface Props {
  files: PullRequestFile[];
  approvals: FileApprovalState[];
  selectedPath: string | null;
  currentUserEmail: string;
  busyPath: string | null;
  onSelect(path: string): void;
  onApprove(path: string): void;
  onUnapprove(path: string): void;
}

export function PrFilesList({
  files,
  approvals,
  selectedPath,
  currentUserEmail,
  busyPath,
  onSelect,
  onApprove,
  onUnapprove,
}: Props) {
  if (files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-slate-600 px-3">
        No file changes.
      </div>
    );
  }

  // Index approvals by path for O(1) lookup during render.
  const approvalByPath = new Map(approvals.map((a) => [a.path, a]));

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-1">
      {files.map((file) => (
        <PrFileRow
          key={`${file.status}:${file.previousPath ?? ''}:${file.path}`}
          file={file}
          approval={approvalByPath.get(file.path)}
          active={selectedPath === file.path}
          currentUserEmail={currentUserEmail}
          busy={busyPath === file.path}
          onSelect={() => onSelect(file.path)}
          onApprove={() => onApprove(file.path)}
          onUnapprove={() => onUnapprove(file.path)}
        />
      ))}
    </div>
  );
}
