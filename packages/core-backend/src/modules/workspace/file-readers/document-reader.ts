import type { DocExtractService } from './doc-extract.service.js';
import type { ExtractFn } from './doc-extract.types.js';
import { displayPath, oneLine, type FileReader, type ReadResult } from './file-reader.js';

/**
 * FileReader over one document format: a thin wrapper pairing the format's
 * PURE extract function (extract-docx.ts and friends) with the shared
 * content-hash extraction cache (`DocExtractService`). Reads return the
 * extraction under its honest `[extracted text of …]` marker; a parse failure
 * becomes a refusal message, never a 500.
 *
 * `grep` semantics: `greppableText` serves only the CACHED extraction (a hit
 * costs one small JSON read), returning null for a cold document — whether to
 * spend grep's per-walk extraction budget on a cold one is the walk's call,
 * which then extracts through `read` (see grepWalk in workspace.tools.ts).
 * grep also branches on `instanceof DocumentReader` for exactly that decision.
 */
export class DocumentReader implements FileReader {
  readonly extensions: readonly string[];
  /**
   * `read_file` returns an EXTRACTION for these types, so text written back
   * could not round-trip — the write tools refuse (documents are replaced by
   * uploading a new version).
   */
  readonly textEditable = false;

  constructor(
    extension: string,
    private readonly extract: ExtractFn,
    private readonly service: DocExtractService,
  ) {
    this.extensions = [extension];
  }

  async read(bytes: Buffer, path: string): Promise<ReadResult> {
    // An extractor is contracted to ANSWER for bad content rather than throw,
    // but it wraps third-party parsers, and one of those throwing past its own
    // guard is a corrupt file — not a server fault. read_file says so instead
    // of failing the whole tool call with a 500.
    let res: Awaited<ReturnType<typeof this.service.extract>>;
    try {
      res = await this.service.extract(path, bytes, this.extract);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        kind: 'refusal',
        message: `[${displayPath(path)} could not be extracted (${oneLine(reason)}) — the file may be corrupt or mislabeled. To fix it, replace the document by uploading a new version.]`,
      };
    }

    return res.ok
      ? { kind: 'text', text: `${res.marker}\n${res.text}` }
      : {
          kind: 'refusal',
          message: `[${displayPath(path)} ${oneLine(res.message)} — the file may be corrupt or mislabeled. To fix it, replace the document by uploading a new version.]`,
        };
  }

  /** The cached extraction (marker line included, so grep's line numbers match read_file's), or null when cold. */
  async greppableText(bytes: Buffer, path: string): Promise<string | null> {
    const hit = await this.service.getCached(path, bytes);
    return hit ? `${hit.marker}\n${hit.text}` : null;
  }
}
