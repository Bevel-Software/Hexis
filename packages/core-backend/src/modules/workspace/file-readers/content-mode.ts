import { DocumentReader } from './document-reader.js';
import type { FileReader } from './file-reader.js';
import { isTextBytes } from './text-reader.js';

/**
 * What the file tools can do with a file's content — the answer `file_stat`
 * reports so an agent can decide BEFORE acting:
 *  - `text`: read_file returns it, and write_file/write_files/edit_file accept it;
 *  - `document`: read_file returns an EXTRACTION; the text tools refuse it;
 *  - `binary`: bytes only — copy_file/move_file/delete_file/unzip act on it,
 *    upload replaces it, and the text tools refuse it.
 */
export type ContentMode = 'text' | 'document' | 'binary';

/**
 * The content mode of a file read by `reader`. `bytes` is the file's current
 * content, consulted only when the reader's answer depends on it (a text-
 * editable reader holding binary content is `binary`); pass undefined when
 * there is nothing there yet.
 */
export function contentModeOf(reader: FileReader, bytes: Buffer | undefined): ContentMode {
  if (reader instanceof DocumentReader) return 'document';
  if (!reader.textEditable) return 'binary';
  if (reader.editRefusalForExisting === undefined || bytes === undefined) return 'text';
  return isTextBytes(bytes) ? 'text' : 'binary';
}

/**
 * Does `reader`'s answer depend on the bytes? Only a text-editable reader that
 * judges existing content (the fallback) does; every other reader answers from
 * the extension alone, so stat need not read the file.
 */
export function needsContent(reader: FileReader): boolean {
  return reader.textEditable && reader.editRefusalForExisting !== undefined;
}

/** What a file IS, as `file_stat` reports it. Archives count as `binary`; their `mime` says which. */
export type StatKind = 'text' | 'document' | 'image' | 'binary';

/**
 * Where `mime` came from: the reader's extension, a content sniff (text with no
 * known extension is `text/plain`), or the octet-stream fallback — which names
 * no type at all.
 */
export type MimeSource = 'extension' | 'sniff' | 'fallback';

export interface FileType {
  contentMode: ContentMode;
  kind: StatKind;
  mime: string;
  mimeSource: MimeSource;
  /** Would write_file/write_files/edit_file accept this file as it is now? */
  textEditable: boolean;
  /** Present only for `mimeSource: 'fallback'`: says the mime is not a detected type. */
  mimeNote?: string;
}

export const OCTET_STREAM_FALLBACK_NOTE =
  '`application/octet-stream` is a fallback, not a detected type: no reader names a MIME type for this extension, and the content is not text.';

/**
 * `file_stat`'s classification, decided by the SAME reader `read_file`, `grep`
 * and the write gates dispatch to — there is no second table. `bytes` follows
 * `contentModeOf`: pass the content when `needsContent(reader)`, so the stat
 * judges exactly what the read and the write gate judge.
 */
export function fileTypeOf(reader: FileReader, path: string, bytes: Buffer | undefined): FileType {
  const contentMode = contentModeOf(reader, bytes);
  const kind: StatKind =
    contentMode === 'text'
      ? 'text'
      : reader.fileKind === 'text' || reader.fileKind === 'archive'
        ? 'binary'
        : reader.fileKind;
  const textEditable = contentMode === 'text';
  const named = reader.mimeFor?.(path);
  if (named !== undefined) return { contentMode, kind, mime: named, mimeSource: 'extension', textEditable };
  if (contentMode === 'text') return { contentMode, kind, mime: 'text/plain', mimeSource: 'sniff', textEditable };
  return {
    contentMode,
    kind,
    mime: 'application/octet-stream',
    mimeSource: 'fallback',
    textEditable,
    mimeNote: OCTET_STREAM_FALLBACK_NOTE,
  };
}
