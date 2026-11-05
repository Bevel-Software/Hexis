import { DocumentReader } from './document-reader.js';

/**
 * FileReader over one email format (`.eml` / `.msg`): a `DocumentReader` in
 * every mechanical respect — cache-wrapped extraction, greppable when cached,
 * corrupt files answered with the typed could-not-be-parsed refusal — with
 * only the WRITE-refusal copy specialized. The generic document refusal talks
 * about round-tripping an office document; an email deserves the honest
 * version of the same "no": the file is a snapshot of a message, and editing
 * a snapshot's text is not a thing.
 */
export class EmailReader extends DocumentReader {
  /** The write-refusal for the agent text-editing tools (see `assertNotDocumentEdit`). */
  editRefusal(path: string): string {
    return (
      `"${path}" is an email file — a snapshot of a message. read_file returns EXTRACTED text for it, ` +
      'and a snapshot cannot be text-edited; to change what is stored, replace the file by uploading ' +
      'a new version.'
    );
  }
}
