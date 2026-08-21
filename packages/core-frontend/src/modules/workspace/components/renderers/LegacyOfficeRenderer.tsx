import { FileText } from 'lucide-react';
import { DownloadFileButton } from './DownloadFileButton';
import type { FileRendererProps } from './types';

/**
 * Pre-2007 Office binaries (`.doc` / `.ppt` / `.xls`). Nothing in the
 * browser parses these — they are OLE compound documents, not zipped XML —
 * so instead of the old behaviour (the text fallback printing megabytes of
 * undecodable bytes) the viewer says what the file is and offers the two
 * honest ways forward: download it, or re-save it in the modern format the
 * viewers next door DO render. The backend's agent-facing `read_file` gives
 * the same convert-to-modern hint for these extensions.
 */
const LEGACY_FORMATS: Record<string, { label: string; modern: string }> = {
  '.doc': { label: 'Word', modern: '.docx' },
  '.ppt': { label: 'PowerPoint', modern: '.pptx' },
  '.xls': { label: 'Excel', modern: '.xlsx' },
};

export function LegacyOfficeRenderer({ filePath }: FileRendererProps) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const format = LEGACY_FORMATS[ext] ?? { label: 'Office', modern: 'a modern format' };

  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
      <FileText size={20} className="text-ink-faint" aria-hidden />
      <p className="max-w-md text-ui text-ink-muted">
        This is a legacy {format.label} format ({ext}) that can't be previewed here. Convert it
        to {format.modern} to view it, or download the original.
      </p>
      <DownloadFileButton filePath={filePath} size="sm" />
    </div>
  );
}
