import { extractionMarker, fileExtension, type ExtractFn, type ExtractResult } from './doc-extract.types.js';
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
 * cache correct. Failures are NOT cached (rare, and fail fast). The key also carries
 * `EXTRACTION_SCHEMA`, so an upgrade that changes what an extractor emits does
 * not keep serving the previous release's text for unchanged bytes.
 */
/**
 * Bumped whenever extraction OUTPUT changes — a new extractor, a fixed one, a
 * reworded summary, a different marker.
 *
 * The rest of the key is content, and content-addressing is only correct while
 * the same bytes mean the same text. An upgrade that changes what an extractor
 * emits breaks that: every already-cached document would keep serving the OLD
 * extraction forever, because its bytes never changed. Bumping this retires
 * those entries (the cache evicts by age, so they cost nothing for long).
 *
 * v2: extraction moved from hand-rolled scanning to a real XML/HTML parser,
 * which changed self-closing paragraphs, entity edge cases and recovery from
 * malformed parts.
 */
export const EXTRACTION_SCHEMA = 'v2';

export class DocExtractService {
  private readonly cache: DocExtractionCache;
  /**
   * Cold extractions currently running, by cache key. Two reads of the same
   * document arriving together would otherwise BOTH parse it — the expensive
   * half of this service, run twice for one answer — because neither had
   * written the cache entry yet when the other looked.
   */
  private readonly inFlight = new Map<string, Promise<ExtractResult>>();

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
    const running = this.inFlight.get(key);
    const result = await (running ??
      (() => {
        // The cache write stays INSIDE the shared promise: were the entry
        // dropped as soon as parsing settled, a read arriving during the
        // write would miss both the cache and the in-flight map — and parse
        // the same document again.
        const started = (async (): Promise<ExtractResult> => {
          const res = await extractFn(bytes);
          if (res.ok) await this.cache.put(key, { summary: res.summary, text: res.text });
          return res;
        })().finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, started);
        return started;
      })());
    if (!result.ok) return result;
    return { ok: true, marker: extractionMarker(path, result.summary), text: result.text };
  }

  /** Content hash + lowercased extension — e.g. `…sha….odt` (see the class doc). */
  private cacheKey(path: string, bytes: Buffer): string {
    return `${gitBlobSha(bytes)}${fileExtension(path)}.${EXTRACTION_SCHEMA}`;
  }
}
