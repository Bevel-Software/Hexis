import { extractionMarker, type ExtractFn } from './doc-extract.types.js';
import { DocExtractionCache, gitBlobSha } from './extraction-cache.js';

/** An extraction ready for a consumer: the honest marker header + the text. */
export interface DocExtraction {
  /** e.g. `[extracted text of Plugins/GTM/deck.pptx — 14 slides + notes; layout, images and formatting omitted]` */
  marker: string;
  text: string;
}

/** What `extract` returns: a marker+text, or a typed could-not-parse failure. */
export type DocExtractOutcome =
  | ({ ok: true } & DocExtraction)
  | { ok: false; message: string };

/**
 * The content-hash CACHE wrap around document text extraction. The per-format
 * `DocumentReader`s in the file-reader registry stay pure (each pairs one
 * extension with one extract function); this service adds the caching
 * generically — a reader hands its extract function in, and the service only
 * runs it on a cache miss.
 *
 * Caching: keyed by the git BLOB sha of the bytes (see `gitBlobSha`), stored
 * as `{ summary, text }` WITHOUT the path — the marker is assembled per call
 * so the same content read under two paths (copies, branches) shares one
 * entry yet each read's marker names the path that was read. Extraction is
 * deterministic (stable slide/sheet/page ordering), which is what makes a
 * content-keyed cache correct. Failures are NOT cached (rare, and fail fast).
 */
export class DocExtractService {
  private readonly cache: DocExtractionCache;

  constructor(cacheRoot: string) {
    this.cache = new DocExtractionCache(cacheRoot);
  }

  /**
   * The CACHED extraction for these bytes, or undefined on a cache miss —
   * never extracts. `grep` uses this (via `DocumentReader.greppableText`) to
   * search already-extracted documents for free and apply its per-walk budget
   * only to cold ones.
   */
  async getCached(path: string, bytes: Buffer): Promise<DocExtraction | undefined> {
    const hit = await this.cache.get(gitBlobSha(bytes));
    return hit && { marker: extractionMarker(path, hit.summary), text: hit.text };
  }

  /** Extract via `extractFn` (cache hit or parse + store). `path` is only used for the marker. */
  async extract(path: string, bytes: Buffer, extractFn: ExtractFn): Promise<DocExtractOutcome> {
    const sha = gitBlobSha(bytes);
    const hit = await this.cache.get(sha);
    if (hit) return { ok: true, marker: extractionMarker(path, hit.summary), text: hit.text };
    const result = await extractFn(bytes);
    if (!result.ok) return result;
    await this.cache.put(sha, { summary: result.summary, text: result.text });
    return { ok: true, marker: extractionMarker(path, result.summary), text: result.text };
  }
}
