import type { IDocumentExtractor } from './document-extractor.contract.js';
import { extractionMarker, fileExtension, type ExtractedDoc } from './doc-extract.types.js';
import { DocExtractionCache, gitBlobSha } from './extraction-cache.js';
import type { ReadOrigin } from './file-reader.js';

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
 * What one read of some bytes answers before any path names it: the cache's
 * own shape (an extraction, or a failure's message). `named` turns it into
 * what `extract` returns for the path it was asked about.
 */
type RawOutcome = ({ ok: true } & ExtractedDoc) | { ok: false; message: string };

/** `raw` as the answer for `path`: its marker names that path. */
function named(path: string, raw: RawOutcome): DocExtractOutcome {
  return raw.ok ? { ok: true, marker: extractionMarker(path, raw.summary), text: raw.text } : raw;
}

/** A document whose extraction just failed, as the people looking at it are told. */
export interface UnreadableDocument {
  workspaceId: string;
  path: string;
  /** What went wrong, worded to follow "Could not be read:". */
  reason: string;
}

export interface DocExtractServiceOptions {
  /** The clock a remembered timeout is judged by (epoch ms). Default `Date.now`. */
  now?: () => number;
  /**
   * Told once per FRESH failure of an extraction a read with an origin
   * started — never for a failure answered from memory. The composition root
   * turns it into the `document-unreadable` event.
   */
  onUnreadable?: (doc: UnreadableDocument) => void;
}

/**
 * How long an extraction stopped over its budget, or whose worker died under
 * it, is remembered: an overrun is a property of the moment (a busy server, a
 * large file), not of the bytes, so it is tried again after this. A parser's
 * refusal is a property of the bytes and is remembered like a success
 * (decided 2026-10-15/19).
 */
export const TIMEOUT_MEMORY_MS = 60 * 60 * 1000;

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
 * cache correct.
 *
 * Extraction itself runs in a worker, under a budget (`IDocumentExtractor`),
 * and its FAILURES are remembered under the same key: a parser's refusal for
 * good, so damaged bytes cost the server once for as long as the entry is
 * kept (the cache evicts by size, as it does successes), and a timeout or a
 * crash for {@link TIMEOUT_MEMORY_MS}. A re-saved file is new content and is
 * extracted again. Only "no worker was free" is not remembered: it says
 * nothing about the file. The key also carries
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
 *
 * v3: Word soft line breaks and tab elements (and PowerPoint `<a:br/>`) now
 * yield a space / tab instead of fusing the words around them.
 */
export const EXTRACTION_SCHEMA = 'v3';

export class DocExtractService {
  private readonly cache: DocExtractionCache;
  private readonly now: () => number;
  private readonly onUnreadable: ((doc: UnreadableDocument) => void) | undefined;
  /**
   * Reads currently running, by cache key — the cache lookup included, from
   * the moment `extract` is called. Two reads of the same document arriving
   * together would otherwise BOTH parse it — the expensive half of this
   * service, run twice for one answer — because neither had written the
   * cache entry yet when the other looked. The entry is set before anything
   * is awaited: were the lookup awaited first, a second read could miss the
   * cache (its read of the file started before the first read's write) AND
   * the map (the first read finished and left it in that window), and parse
   * the document again, telling the people looking at it twice.
   *
   * What is shared is exactly what the key identifies — the bytes' extraction
   * under a format, which is what the cache holds — and nothing of the read
   * that started it: the key carries no path, so two reads of the same bytes
   * at different paths share one promise, and each names the answer with its
   * own path (`extract`).
   */
  private readonly inFlight = new Map<string, Promise<RawOutcome>>();

  constructor(
    cacheRoot: string,
    private readonly extractor: IDocumentExtractor,
    opts: DocExtractServiceOptions = {},
  ) {
    this.cache = new DocExtractionCache(cacheRoot);
    this.now = opts.now ?? Date.now;
    this.onUnreadable = opts.onUnreadable;
  }

  /**
   * What the cache REMEMBERS for these bytes — the extraction, or the notice
   * of a failed one — or undefined on a miss; never extracts. `grep` uses this
   * (via `DocumentReader.cachedRead`) to search already-extracted documents
   * for free, skip remembered failures for free, and apply its per-walk budget
   * only to cold ones; `file_stat` uses it to report a remembered failure.
   */
  async getCached(path: string, bytes: Buffer): Promise<DocExtractOutcome | undefined> {
    const hit = await this.remembered(this.cacheKey(path, bytes));
    return hit && named(path, hit);
  }

  /**
   * The extraction of `bytes` (remembered, or run in the extractor's worker
   * and remembered). `path` supplies the marker AND the key's format part;
   * `origin`, when given, is where a fresh failure is reported.
   */
  async extract(path: string, bytes: Buffer, origin?: ReadOrigin): Promise<DocExtractOutcome> {
    // The bytes are hashed BEFORE the extractor takes its copy of them.
    const key = this.cacheKey(path, bytes);
    return named(path, await (this.inFlight.get(key) ?? this.read(key, path, bytes, origin)));
  }

  /** What the cache holds for `key`, or undefined on a miss. */
  private async remembered(key: string): Promise<RawOutcome | undefined> {
    const hit = await this.cache.get(key, this.now());
    if (!hit) return undefined;
    return hit.failed ? { ok: false, message: hit.message } : { ok: true, summary: hit.summary, text: hit.text };
  }

  /**
   * One read of `bytes`, shared by every `extract` of the same key that
   * arrives before it settles (see `inFlight`): the cache lookup, then the
   * extraction and its cache write. The write stays INSIDE the shared
   * promise: were the entry dropped as soon as parsing settled, a read
   * arriving during the write would miss both the cache and the map — and
   * parse the same document again. A failure is reported to the FIRST
   * read's origin and path, once; `path` otherwise gives only the format,
   * which every read of the key shares.
   */
  private read(key: string, path: string, bytes: Buffer, origin: ReadOrigin | undefined): Promise<RawOutcome> {
    const started = (async (): Promise<RawOutcome> => {
      const hit = await this.remembered(key);
      if (hit) return hit;
      const res = await this.extractor.extract(fileExtension(path), bytes);
      if (res.ok) {
        await this.cache.put(key, { summary: res.summary, text: res.text });
        return { ok: true, summary: res.summary, text: res.text };
      }
      if (res.failure !== 'busy') {
        const until = res.failure === 'parser' ? undefined : this.now() + TIMEOUT_MEMORY_MS;
        await this.cache.put(key, { failed: true, message: res.message, ...(until === undefined ? {} : { until }) });
        if (origin) this.notifyUnreadable({ workspaceId: origin.workspaceId, path, reason: reasonOf(res.message) });
      }
      return { ok: false, message: res.message };
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  /** Best-effort, like every event: a listener that throws never fails the read. */
  private notifyUnreadable(doc: UnreadableDocument): void {
    try {
      this.onUnreadable?.(doc);
    } catch {
      // the read still answers its notice
    }
  }

  /** Content hash + lowercased extension — e.g. `…sha….odt` (see the class doc). */
  private cacheKey(path: string, bytes: Buffer): string {
    return `${gitBlobSha(bytes)}${fileExtension(path)}.${EXTRACTION_SCHEMA}`;
  }
}

/** A failure's notice, worded to follow "Could not be read:" (the explorer's copy) without saying it twice. */
function reasonOf(message: string): string {
  return message.replace(/^could not be read: /, '');
}
