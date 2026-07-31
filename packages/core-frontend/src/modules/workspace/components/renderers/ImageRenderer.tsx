import { useState, useEffect } from 'react';
import { useWorkspace } from '../../state/workspace.context';
import { authFetch } from '../../../../lib/api';
import type { FileRendererProps } from './types';

export function ImageRenderer({ filePath }: FileRendererProps) {
  const { workspaceId } = useWorkspace();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;

    let revoked = false;
    (async () => {
      const res = await authFetch(
        `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(filePath)}`,
      );
      if (!res.ok || revoked) return;
      const blob = await res.blob();
      if (revoked) return;
      setObjectUrl(URL.createObjectURL(blob));
    })();

    return () => {
      revoked = true;
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [workspaceId, filePath]);

  if (!objectUrl) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        Loading image...
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full overflow-auto">
      <img
        src={objectUrl}
        alt={filePath}
        className="max-w-full max-h-full object-contain rounded"
      />
    </div>
  );
}
