import type { ComponentType } from 'react';
import type { FileRendererProps } from './types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TextRenderer } from './TextRenderer';
import { ImageRenderer } from './ImageRenderer';
import { HtmlRenderer } from './HtmlRenderer';
import { PdfRenderer } from './PdfRenderer';
import { DocxRenderer } from './DocxRenderer';
import { XlsxRenderer } from './XlsxRenderer';
import { CsvRenderer } from './CsvRenderer';
import { ToolRenderer } from './ToolRenderer';

export type { FileRendererProps, RendererSaveState } from './types';

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
