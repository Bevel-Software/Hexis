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
