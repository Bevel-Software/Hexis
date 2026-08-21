import { FileText } from 'lucide-react';
import { DownloadFileButton } from './DownloadFileButton';
import type { FileRendererProps } from './types';

/**
 * The no-preview note, in two honest flavours:
 *
 *  - Pre-2007 Office binaries (`.doc` / `.ppt` / `.xls`): nothing in the
 *    browser (or on the backend) parses these — they are OLE compound
 *    documents, not zipped XML — so the note names the format and the two
 *    ways forward: convert to the modern format the viewers next door DO
 *    render, or download the original. The backend's agent-facing
 *    `read_file` gives the same convert-to-modern hint.
 *
 *  - OpenDocument files (`.odt` / `.odp` / `.ods`): agents read these fine
 *    (the backend extracts their text) — only the browser viewer is missing.
 *    So the copy says exactly that and offers Download, WITHOUT a convert
 *    hint that would wrongly imply the file is unusable as-is.
 *
 * Either way this beats the old behaviour: the text fallback printing
 * megabytes of undecodable bytes.
 */
const LEGACY_FORMATS: Record<string, { label: string; modern: string }> = {
  '.doc': { label: 'Word', modern: '.docx' },
  '.ppt': { label: 'PowerPoint', modern: '.pptx' },
  '.xls': { label: 'Excel', modern: '.xlsx' },
};

/** ODF family → what the file is, for the no-preview-yet copy. */
const ODF_FORMATS: Record<string, string> = {
  '.odt': 'text document',
  '.odp': 'presentation',
  '.ods': 'spreadsheet',
};

export function LegacyOfficeRenderer({ filePath }: FileRendererProps) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const odf = ODF_FORMATS[ext];
  const format = LEGACY_FORMATS[ext] ?? { label: 'Office', modern: 'a modern format' };

  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
      <FileText size={20} className="text-ink-faint" aria-hidden />
      <p className="max-w-md text-ui text-ink-muted">
        {odf !== undefined ? (
          <>
            No preview for OpenDocument files yet — this is an OpenDocument {odf} ({ext}).
            Download the file to view it.
          </>
        ) : (
          <>
            This is a legacy {format.label} format ({ext}) that can't be previewed here. Convert
            it to {format.modern} to view it, or download the original.
          </>
        )}
      </p>
      <DownloadFileButton filePath={filePath} size="sm" />
    </div>
  );
}
