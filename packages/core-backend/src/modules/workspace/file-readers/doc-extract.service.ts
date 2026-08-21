import { extractionMarker, fileExtension, type ExtractFn } from './doc-extract.types.js';
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
 * Caching: keyed by the git BLOB sha of the bytes (see `gitBlobSha`) PLUS the
 * path's extension, stored as `{ summary, text }` WITHOUT the path — the
 * marker is assembled per call so the same content read under two paths
 * (copies, branches) shares one entry yet each read's marker names the path
 * that was read. The extension is part of the key because identical bytes
 * extract DIFFERENTLY per format: a `.odt` renamed `.ods` must run the ods
 * extractor, not return the odt extraction. Extraction is deterministic
 * (stable slide/sheet/page ordering), which is what makes a content-keyed
 * cache correct. Failures are NOT cached (rare, and fail fast).
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
    const hit = await this.cache.get(this.cacheKey(path, bytes));
    return hit && { marker: extractionMarker(path, hit.summary), text: hit.text };
  }

  /** Extract via `extractFn` (cache hit or parse + store). `path` supplies the marker AND the key's format part. */
  async extract(path: string, bytes: Buffer, extractFn: ExtractFn): Promise<DocExtractOutcome> {
    const key = this.cacheKey(path, bytes);
    const hit = await this.cache.get(key);
    if (hit) return { ok: true, marker: extractionMarker(path, hit.summary), text: hit.text };
    const result = await extractFn(bytes);
    if (!result.ok) return result;
    await this.cache.put(key, { summary: result.summary, text: result.text });
    return { ok: true, marker: extractionMarker(path, result.summary), text: result.text };
  }

  /** Content hash + lowercased extension — e.g. `…sha….odt` (see the class doc). */
  private cacheKey(path: string, bytes: Buffer): string {
    return `${gitBlobSha(bytes)}${fileExtension(path)}`;
  }
}
