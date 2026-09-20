import { isUtf8 } from 'node:buffer';
import { fileExtension } from './doc-extract.types.js';
import { displayPath, type FileKind, type FileReader, type ReadResult } from './file-reader.js';

/**
 * Extension→mime for the binary-read notice and for the `mime` `file_stat`
 * reports (fallback: octet-stream, or text/plain for sniffed text). Every
 * extension a reader registers must name its mime here or in that reader's
 * own `mimeFor` — the registry test enforces it.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.doc': 'application/msword',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.xls': 'application/vnd.ms-excel',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.eml': 'message/rfc822',
  '.msg': 'application/vnd.ms-outlook',
  '.wasm': 'application/wasm',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dll': 'application/vnd.microsoft.portable-executable',
  '.so': 'application/x-sharedlib',
  // `.bin` itself names raw bytes: an extension-given type, not the fallback.
  '.bin': 'application/octet-stream',
};

/** The mime `path`'s extension names, or undefined when the table has none. */
export function extensionMime(path: string): string | undefined {
  return MIME_BY_EXT[fileExtension(path)];
}

/**
 * Text is what the fallback reader may hand to the text tools: no NUL byte
 * AND valid UTF-8. A NUL-free file that does not decode as UTF-8 is still
 * binary here — the decode would be lossy, so text written back could never
 * round-trip the original bytes. Checked on the raw bytes, so a large binary
 * is refused without allocating its full decoded string first.
 */
export function isTextBytes(bytes: Buffer): boolean {
  return !bytes.includes(0) && isUtf8(bytes);
}

/**
 * The DEFAULT reader — the registry's fallback for every extension no other
 * reader owns. Decodes utf8 text; content carrying a NUL byte or invalid
 * UTF-8 is not (round-trippable) text at all, so the read answers with an
 * honest one-line notice INSTEAD of raw bytes: what the file is (mime by
 * extension + size), plus the actionable hint where one exists (unzip for
 * archives). Same binary test on the grep path: binary content is simply not
 * searchable.
 */
export class TextReader implements FileReader {
  /** Fallback reader: matched by the registry's default, not by extension. */
  readonly extensions: readonly string[] = [];
  readonly textEditable: boolean = true;
  readonly fileKind: FileKind = 'text';

  async read(bytes: Buffer, path: string): Promise<ReadResult> {
    return isTextBytes(bytes)
      ? { kind: 'text', text: bytes.toString('utf8') }
      : { kind: 'refusal', message: this.binaryNotice(path, bytes.length) };
  }

  /**
   * Binary content is not editable, whatever its extension. `read` answers a
   * binary file with a notice INSTEAD of its bytes, so an agent asking to
   * write text over one would be overwriting something it could not read. The
   * write tools refuse instead. (Uploads and the HTTP write routes are
   * untouched: a human replacing a file is exactly the right move.)
   */
  editRefusalForExisting(bytes: Buffer, path: string): string | null {
    return isTextBytes(bytes)
      ? null
      : `"${displayPath(path)}" holds binary content, which read_file cannot show as text. Writing text over it would ` +
          `destroy those bytes — replace the file by uploading a new version instead.`;
  }

  async greppableText(bytes: Buffer): Promise<string | null> {
    return isTextBytes(bytes) ? bytes.toString('utf8') : null; // skip binary (NUL / invalid UTF-8)
  }

  mimeFor(path: string): string | undefined {
    return extensionMime(path);
  }

  /** The honest one-line notice returned INSTEAD of raw bytes for unreadable binary content. */
  protected binaryNotice(path: string, sizeBytes: number): string {
    const ext = fileExtension(path);
    const mime = extensionMime(path) ?? 'application/octet-stream';
    const zipHint = ext === '.zip' ? ' Use the unzip tool to extract its contents.' : '';
    return `[${displayPath(path)} is a binary file (${mime}, ${sizeBytes} bytes) — not readable as text.${zipHint}]`;
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
  override readonly fileKind: FileKind = 'document';

  /** The write-refusal for the agent text-editing tools (see `assertNotDocumentEdit`). */
  editRefusal(path: string): string {
    const ext = fileExtension(path);
    const modern = MODERN_BY_LEGACY[ext] ?? 'the modern format';
    return (
      `"${displayPath(path)}" is a legacy binary office format (${ext}). read_file cannot extract its text, and text ` +
      'written by the editing tools would destroy the binary document. Convert the document to ' +
      `${modern} and upload that, or replace the file by uploading a new version.`
    );
  }

  protected override binaryNotice(path: string, sizeBytes: number): string {
    const ext = fileExtension(path);
    const modern = MODERN_BY_LEGACY[ext];
    return (
      `[${displayPath(path)} is a legacy office format (${ext}, ${sizeBytes} bytes) — text extraction supports only the ` +
      `modern format. Convert the document to ${modern} and upload that to read its text, or replace it by ` +
      'uploading a new version.]'
    );
  }
}

/**
 * Extensions that name bytes no text tool may produce: archives, media, fonts,
 * executables, and the image formats read_file does not return as pictures.
 * Reads and greps stay the text reader's (a mislabeled `.zip` that holds text
 * still reads as text, and binary content still gets the one-line notice), but
 * the write tools refuse them by name — text written to `bundle.zip` can only
 * ever be a broken archive. Bytes of these kinds arrive through upload, or
 * travel with copy_file/move_file.
 */
export class BinaryReader extends TextReader {
  override readonly textEditable: boolean = false;

  constructor(
    override readonly extensions: readonly string[],
    override readonly fileKind: FileKind,
  ) {
    super();
  }
}
