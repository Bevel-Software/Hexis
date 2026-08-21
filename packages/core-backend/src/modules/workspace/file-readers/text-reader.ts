import { fileExtension } from './doc-extract.types.js';
import type { FileReader, ReadResult } from './file-reader.js';

/** Minimal extension→mime map for the binary-read notice (fallback: octet-stream). */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.doc': 'application/msword',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.xls': 'application/vnd.ms-excel',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.exe': 'application/vnd.microsoft.portable-executable',
};

/**
 * The DEFAULT reader — the registry's fallback for every extension no other
 * reader owns. Decodes utf8 text; content carrying a NUL byte is not text at
 * all, so the read answers with an honest one-line notice INSTEAD of raw
 * bytes: what the file is (mime by extension + size), plus the actionable
 * hint where one exists (unzip for archives). Same NUL test on the grep path:
 * binary content is simply not searchable.
 */
export class TextReader implements FileReader {
  /** Fallback reader: matched by the registry's default, not by extension. */
  readonly extensions: readonly string[] = [];
  readonly textEditable: boolean = true;

  async read(bytes: Buffer, path: string): Promise<ReadResult> {
    const text = bytes.toString('utf8');
    return text.includes('\0')
      ? { kind: 'refusal', message: this.binaryNotice(path, bytes.length) }
      : { kind: 'text', text };
  }

  /**
   * Binary content is not editable, whatever its extension. `read` answers a
   * NUL-bearing file with a notice INSTEAD of its bytes, so an agent asking to
   * write text over one would be overwriting something it could not read. The
   * write tools refuse instead. (Uploads and the HTTP write routes are
   * untouched: a human replacing a file is exactly the right move.)
   */
  editRefusalForExisting(bytes: Buffer, path: string): string | null {
    return bytes.includes(0)
      ? `"${path}" holds binary content, which read_file cannot show as text. Writing text over it would ` +
          `destroy those bytes — replace the file by uploading a new version instead.`
      : null;
  }

  async greppableText(bytes: Buffer): Promise<string | null> {
    const text = bytes.toString('utf8');
    return text.includes('\0') ? null : text; // skip binary (NUL)
  }

  /** The honest one-line notice returned INSTEAD of raw bytes for unreadable binary content. */
  protected binaryNotice(path: string, sizeBytes: number): string {
    const ext = fileExtension(path);
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    const zipHint = ext === '.zip' ? ' Use the unzip tool to extract its contents.' : '';
    return `[${path} is a binary file (${mime}, ${sizeBytes} bytes) — not readable as text.${zipHint}]`;
  }
}

/** The modern OOXML counterpart of each legacy binary office extension. */
const MODERN_BY_LEGACY: Record<string, string> = { '.doc': '.docx', '.ppt': '.pptx', '.xls': '.xlsx' };

/**
 * Legacy binary office formats (.doc/.ppt/.xls) — NOT extractable (text
 * extraction supports only the modern formats), so a binary read gets the
 * convert-to-modern hint instead of the generic notice. Reads and greps are
 * otherwise the text reader's behaviour: a legacy-named file that happens to
 * hold plain text still reads (and greps) as text.
 *
 * NOT text-editable: read_file cannot extract a binary legacy document, so an
 * edit_file/write_file on one would overwrite the real document with text
 * that never round-tripped — the write tools refuse with the convert-or-
 * replace message below.
 */
export class LegacyOfficeReader extends TextReader {
  override readonly extensions: readonly string[] = ['.doc', '.ppt', '.xls'];
  override readonly textEditable: boolean = false;

  /** The write-refusal for the agent text-editing tools (see `assertNotDocumentEdit`). */
  editRefusal(path: string): string {
    const ext = fileExtension(path);
    const modern = MODERN_BY_LEGACY[ext] ?? 'the modern format';
    return (
      `"${path}" is a legacy binary office format (${ext}). read_file cannot extract its text, and text ` +
      'written by the editing tools would destroy the binary document. Convert the document to ' +
      `${modern} and upload that, or replace the file by uploading a new version.`
    );
  }

  protected override binaryNotice(path: string, sizeBytes: number): string {
    const ext = fileExtension(path);
    const modern = MODERN_BY_LEGACY[ext];
    return (
      `[${path} is a legacy office format (${ext}, ${sizeBytes} bytes) — text extraction supports only the ` +
      `modern format. Convert the document to ${modern} and upload that to read its text, or replace it by ` +
      'uploading a new version.]'
    );
  }
}
