import type { DocExtractOutcome, DocExtractService } from './doc-extract.service.js';
import { displayPath, oneLine, type FileReader, type ReadOrigin, type ReadResult } from './file-reader.js';
import { extensionMime } from './text-reader.js';

/**
 * FileReader over one document format: a thin wrapper around the shared
 * content-hash extraction service (`DocExtractService`), which runs the
 * format's extractor in a worker and remembers what it answered. Reads return
 * the extraction under its honest `[extracted text of …]` marker; a failed
 * extraction becomes a refusal message, never a 500.
 *
 * `grep` semantics: `cachedRead` answers only what the cache REMEMBERS (a hit
 * costs one small JSON read) — the extraction, or a failure's notice — and
 * undefined for a cold document; whether to spend grep's per-walk extraction
 * budget on a cold one is the walk's call, which then extracts through `read`
 * (see grepWalk in workspace.tools.ts). grep also branches on
 * `instanceof DocumentReader` for exactly that decision.
 */
export class DocumentReader implements FileReader {
  readonly extensions: readonly string[];
  /**
   * `read_file` returns an EXTRACTION for these types, so text written back
   * could not round-trip — the write tools refuse (documents are replaced by
   * uploading a new version).
   */
  readonly textEditable = false;
  readonly fileKind = 'document' as const;

  constructor(
    extension: string,
    private readonly service: DocExtractService,
  ) {
    this.extensions = [extension];
  }

  /** `origin` names the workspace the file was read in, so a fresh failure can be reported there. */
  async read(bytes: Buffer, path: string, origin?: ReadOrigin): Promise<ReadResult> {
    // The service answers every parser failure as an outcome; a throw here is
    // the service's own fault (the cache's disk, say) — still answered as the
    // file's honest refusal rather than failing the whole tool call with a 500.
    let res: DocExtractOutcome;
    try {
      res = await this.service.extract(path, bytes, origin);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      res = { ok: false, message: `could not be extracted (${reason})` };
    }
    return toReadResult(path, res);
  }

  /**
   * What `read` would answer, from the cache alone — the extraction (marker
   * line included, so grep's line numbers match read_file's) or a remembered
   * failure's refusal — or undefined when the document is cold. Never extracts.
   */
  async cachedRead(bytes: Buffer, path: string): Promise<ReadResult | undefined> {
    const hit = await this.service.getCached(path, bytes);
    return hit && toReadResult(path, hit);
  }

  mimeFor(path: string): string | undefined {
    return extensionMime(path);
  }
}

/** One outcome, one wording: the same refusal whether the failure is fresh or remembered. */
function toReadResult(path: string, res: DocExtractOutcome): ReadResult {
  return res.ok
    ? { kind: 'text', text: `${res.marker}\n${res.text}` }
    : {
        kind: 'refusal',
        message: `[${displayPath(path)} ${oneLine(res.message)} — the file may be corrupt or mislabeled. To fix it, replace the document by uploading a new version.]`,
      };
}
