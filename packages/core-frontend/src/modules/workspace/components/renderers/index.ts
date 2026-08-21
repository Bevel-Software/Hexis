import type { ComponentType } from 'react';
import type { FileRendererProps } from './types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TextRenderer } from './TextRenderer';
import { ImageRenderer } from './ImageRenderer';
import { HtmlRenderer } from './HtmlRenderer';
import { CsvRenderer } from './CsvRenderer';
import { ToolRenderer } from './ToolRenderer';
import { LegacyOfficeRenderer } from './LegacyOfficeRenderer';
import { lazyRenderer } from './lazyRenderer';

export type { FileRendererProps, RendererSaveState } from './types';

/**
 * The document viewers are code-split: their parsers (xlsx ~141 KB gzip,
 * mammoth ~119 KB, pdf.js ~340 KB + its worker as a separate asset, jszip
 * ~28 KB) would otherwise sit in the eager bundle for file types most
 * sessions never open — pdf.js alone would grow it by more than a third.
 * `lazyRenderer` carries its own Suspense fallback and error boundary, so
 * these stay plain `ComponentType<FileRendererProps>` values and
 * `getFileRenderer()`'s contract is unchanged.
 *
 * (`LegacyOfficeRenderer` stays eager on purpose: it parses nothing — it is
 * a note and a Download button, smaller than the lazy plumbing would be.)
 */
const XlsxRenderer = lazyRenderer('spreadsheet', () =>
  import('./XlsxRenderer').then((m) => ({ default: m.XlsxRenderer })),
);
const DocxRenderer = lazyRenderer('document', () =>
  import('./DocxRenderer').then((m) => ({ default: m.DocxRenderer })),
);
const PdfRenderer = lazyRenderer('PDF', () =>
  import('./PdfRenderer').then((m) => ({ default: m.PdfRenderer })),
);
const PptxRenderer = lazyRenderer('presentation', () =>
  import('./PptxRenderer').then((m) => ({ default: m.PptxRenderer })),
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
  '.pptx': PptxRenderer,
  // Pre-2007 Office binaries: nothing in the browser parses these, so the
  // viewer says so and offers Download — never the text fallback, which
  // would print megabytes of undecodable bytes.
  '.doc': LegacyOfficeRenderer,
  '.ppt': LegacyOfficeRenderer,
  '.xls': LegacyOfficeRenderer,
  '.csv': CsvRenderer,
  '.tool': ToolRenderer,
};

const fallbackRenderer = TextRenderer;

export function getFileRenderer(filePath: string): ComponentType<FileRendererProps> {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return renderersByExtension[ext] ?? fallbackRenderer;
}

/**
 * How a file's renderer wants to be laid out inside `KbDocumentShell`.
 *
 * Two kinds of renderer, and the difference is not cosmetic:
 *
 *   - **A document.** Markdown, plain text, Word. It has no natural height, so
 *     the shell holds the 880px measure and does the scrolling. An 800px line
 *     is a reading surface; a 2000px one is not.
 *   - **A viewport.** A PDF, an image, a spreadsheet, a sandboxed HTML page, a
 *     tool form. It is already a fixed-height thing with its own scroller, so
 *     the shell yields and hands it a definite height. An `h-full` iframe in an
 *     auto-height column collapses to 0px, and an 880px prose measure is the
 *     wrong shape for a spreadsheet.
 *
 * `.html` is full-bleed even though its EDIT state is a source textarea: the
 * read state is the sandbox iframe, and the extension has to pick one. A
 * full-height source view is harmless; a zero-height preview is not.
 *
 * Deliberately keyed off the extension — the same key `getFileRenderer` uses —
 * so a registry-contributed renderer override for an extension inherits the
 * layout its built-in counterpart had.
 */
export type RendererLayout = 'prose' | 'full-bleed';

// NOT here, deliberately: `.docx` (mammoth's HTML is prose), `.pptx` (the
// outline view is a text document), and the legacy `.doc`/`.ppt`/`.xls`
// (a one-paragraph note) — all documents, all on the prose measure.
const FULL_BLEED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.pdf',
  '.csv', '.xlsx',
  '.html', '.htm',
  '.tool',
]);

export function getRendererLayout(filePath: string): RendererLayout {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return FULL_BLEED_EXTENSIONS.has(ext) ? 'full-bleed' : 'prose';
}

/**
 * Files whose renderer fetches its own bytes and never reads the text buffer.
 *
 * The workspace loads every open file's content as a STRING, so
 * `openFileContent.length` is a number for a PDF too — it is just not a number
 * that means anything, because those bytes were never text. The rail asks this
 * before offering a character count: a figure nobody can interpret is worse
 * than an absent row.
 *
 * Note this is NOT the same set as `FULL_BLEED_EXTENSIONS`. A CSV is laid out
 * full-bleed and is still text you can count.
 *
 * `.svg` IS here, even though its bytes happen to be text: it renders through
 * `ImageRenderer`, which fetches the raw endpoint and hands the browser a
 * picture. Nobody reading a diagram wants to be told it is 4,812 characters of
 * XML, and the buffer the count would come from was never displayed.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.ppt', '.xls', '.zip',
]);

export function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf('.')).toLowerCase());
}
