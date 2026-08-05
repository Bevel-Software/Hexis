import type { ComponentType } from 'react';
import type { FileRendererProps } from './types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TextRenderer } from './TextRenderer';
import { ImageRenderer } from './ImageRenderer';
import { HtmlRenderer } from './HtmlRenderer';
import { PdfRenderer } from './PdfRenderer';
import { CsvRenderer } from './CsvRenderer';
import { ToolRenderer } from './ToolRenderer';
import { lazyRenderer } from './lazyRenderer';

export type { FileRendererProps, RendererSaveState } from './types';

/**
 * `.xlsx` and `.docx` are code-split: their parsers (xlsx ~141 KB gzip,
 * mammoth ~119 KB) were 27% of the eager bundle for file types most sessions
 * never open. `lazyRenderer` carries its own Suspense fallback and error
 * boundary, so these stay plain `ComponentType<FileRendererProps>` values and
 * `getFileRenderer()`'s contract is unchanged.
 */
const XlsxRenderer = lazyRenderer('spreadsheet', () =>
  import('./XlsxRenderer').then((m) => ({ default: m.XlsxRenderer })),
);
const DocxRenderer = lazyRenderer('document', () =>
  import('./DocxRenderer').then((m) => ({ default: m.DocxRenderer })),
);

const renderersByExtension: Record<string, ComponentType<FileRendererProps>> = {
  '.md': MarkdownRenderer,
  '.html': HtmlRenderer,
  '.htm': HtmlRenderer,
  '.png': ImageRenderer,
  '.jpg': ImageRenderer,
  '.jpeg': ImageRenderer,
  '.gif': ImageRenderer,
  '.webp': ImageRenderer,
  '.svg': ImageRenderer,
  '.bmp': ImageRenderer,
  '.ico': ImageRenderer,
  '.pdf': PdfRenderer,
  '.docx': DocxRenderer,
  '.xlsx': XlsxRenderer,
  '.csv': CsvRenderer,
  '.tool': ToolRenderer,
};

const fallbackRenderer = TextRenderer;

export function getFileRenderer(filePath: string): ComponentType<FileRendererProps> {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return renderersByExtension[ext] ?? fallbackRenderer;
}
