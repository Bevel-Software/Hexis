import { Worker } from 'node:worker_threads';
import { exchange, MAX_TIMER_MS, sizingOption, WorkerPool } from '../worker-pool.js';
import {
  extractionTimeoutNotice,
  type IDocumentExtractor,
  type IsolatedExtraction,
} from './document-extractor.contract.js';
import type { ExtractionJob, ExtractionReply } from './extraction-worker.js';
import { logger } from '../../../shared/logging.js';

const log = logger('documents');

/**
 * Extraction time one document may spend in its worker: the platform's rule,
 * not a deployment's (decided 2026-10-19). A longer wait is too unresponsive
 * for a read or a search; the hour a timeout is remembered for is what keeps a
 * hanging file cheap (see `DocExtractService`).
 */
export const EXTRACTION_BUDGET_MS = 10_000;

/** What a document answers when its worker failed outside the parser: never the worker's own error. */
export const EXTRACTION_WORKER_FAILED = 'could not be read: its extraction failed on the server; try again later';

/** The worker script: a module that calls `serveExtractions` (see `extraction-worker.ts`). */
export interface ExtractionWorkerEntry {
  url: URL;
  /** Node options for the worker thread — a TypeScript entry needs its loader. */
  execArgv: string[];
}

export interface WorkerDocumentExtractorOptions {
  /** Worker time one extraction may spend. Default {@link EXTRACTION_BUDGET_MS}. */
  budgetMs?: number;
  /** Workers kept for extractions at once; one past this waits for a worker. Default 4. */
  poolMax?: number;
  /**
   * Extractions that may wait for a worker at once. A waiting extraction holds
   * the file's bytes, so the queue is capped: past it an extraction is answered
   * `busy`, and nothing about the file is remembered. Default 32.
   */
  maxWaiting?: number;
  /**
   * The worker script. Default: the document extractors (`extract.worker`).
   * A composition serving other extractors — a test's misbehaving parser —
   * names its own module calling `serveExtractions`.
   */
  entry?: ExtractionWorkerEntry;
}

/**
 * The one place a document's extractor runs (see {@link IDocumentExtractor}):
 * a pooled worker thread — the extraction worker kind of the shared
 * {@link WorkerPool}, which `grep`'s regex matcher is the other kind of —
 * under a budget per file.
 *
 * The bytes are COPIED once on the request thread and the copy transferred,
 * so the caller's buffer (already hashed for the cache key, and possibly a
 * slice of Node's shared pool) is never detached. Past the budget the worker is
 * terminated, which stops a parser mid-loop, and the file answers the timeout
 * notice. A worker that answers with a dangling rejection, raises, or dies is
 * never reused; the pool replaces it. A rejection the worker cannot pin on
 * this job — it had served another before (see `serveExtractions`) — runs the
 * job again in a fresh worker, so one file's failure is never another's.
 */
export class WorkerDocumentExtractor implements IDocumentExtractor {
  private readonly budgetMs: number;
  private readonly pool: WorkerPool;
  private nextJob = 1;
  private closing = false;

  constructor(opts: WorkerDocumentExtractorOptions = {}) {
    this.budgetMs = sizingOption('WorkerDocumentExtractor', 'budgetMs', opts.budgetMs ?? EXTRACTION_BUDGET_MS, 1, MAX_TIMER_MS);
    const entry = opts.entry ?? defaultEntry();
    this.pool = new WorkerPool(
      () => new Worker(entry.url, { execArgv: entry.execArgv }),
      {
        // Three documents extracted at once each get a worker of their own.
        poolMax: sizingOption('WorkerDocumentExtractor', 'poolMax', opts.poolMax ?? 4, 1),
        maxWaiting: sizingOption('WorkerDocumentExtractor', 'maxWaiting', opts.maxWaiting ?? 32, 0),
      },
      () => new ExtractionBusyError(),
    );
  }

  async extract(extension: string, bytes: Buffer): Promise<IsolatedExtraction> {
    const started = Date.now();
    const first = await this.attempt(extension, bytes, this.budgetMs, false);
    if (!('unattributed' in first)) return first;
    // A rejection came while a worker that had served another job ran this one,
    // and may be that job's: run it again where it is the first job, so what
    // the file is answered (and remembered) as is its own. Within the budget.
    const left = this.budgetMs - (Date.now() - started);
    if (left <= 0) return { ok: false, failure: 'timeout', message: extractionTimeoutNotice(this.budgetMs) };
    const again = await this.attempt(extension, bytes, left, true);
    // In a fresh worker the worker never answers `unattributed`; a crash of the moment if it ever did —
    // and never with that rejection's words, which may be another file's.
    return 'unattributed' in again ? { ok: false, failure: 'crashed', message: EXTRACTION_WORKER_FAILED } : again;
  }

  private async attempt(
    extension: string,
    bytes: Buffer,
    budgetMs: number,
    fresh: boolean,
  ): Promise<IsolatedExtraction | { unattributed: true; message: string }> {
    let w: Worker;
    try {
      w = await (fresh ? this.pool.acquireFresh() : this.pool.acquire());
    } catch {
      return busy();
    }
    const copy = new Uint8Array(bytes);
    const job: ExtractionJob = { id: this.nextJob++, extension, bytes: copy };
    const outcome = await exchange<ExtractionReply>(w, job, budgetMs, [copy.buffer]);
    if ('timeout' in outcome) {
      this.pool.discard(w);
      return { ok: false, failure: 'timeout', message: extractionTimeoutNotice(this.budgetMs) };
    }
    if ('error' in outcome) {
      // Raised outside every guard the worker installs — its script failed to
      // load, or it ran out of memory: a fault of the moment rather than of
      // the bytes. The worker is ending, and the pool replaces it. What went
      // wrong is the server's (a module path, a heap size): logged here, and
      // the reader is told — and the hour remembers — the same words each time.
      log.error('an extraction worker failed', { err: outcome.error });
      return { ok: false, failure: 'crashed', message: EXTRACTION_WORKER_FAILED };
    }
    if ('exited' in outcome) {
      if (this.closing) return busy();
      return {
        ok: false,
        failure: 'crashed',
        message: `could not be read: its extraction stopped unexpectedly (exit code ${outcome.exited})`,
      };
    }
    const { reply } = outcome;
    if (reply.retire) this.pool.discard(w);
    else this.pool.release(w);
    if (reply.unattributed && !reply.ok) return { unattributed: true, message: reply.message };
    return reply.ok
      ? { ok: true, summary: reply.summary, text: reply.text }
      : { ok: false, failure: reply.transient ? 'crashed' : 'parser', message: reply.message };
  }

  close(): Promise<void> {
    this.closing = true;
    return this.pool.close();
  }
}

/** Every worker busy and the queue for one full. */
class ExtractionBusyError extends Error {
  constructor() {
    super('every extraction worker is busy');
    this.name = 'ExtractionBusyError';
  }
}

function busy(): IsolatedExtraction {
  return {
    ok: false,
    failure: 'busy',
    message: 'could not be read: too many documents are being extracted at once; try again in a few seconds',
  };
}

/**
 * The document extractors' worker, beside this module. Run from the build it
 * is plain JavaScript; run from source (the test suites) it is TypeScript,
 * which a worker thread loads through `tsx`, as the suites themselves are.
 */
function defaultEntry(): ExtractionWorkerEntry {
  const fromSource = import.meta.url.endsWith('.ts');
  return {
    url: new URL(fromSource ? './extract.worker.ts' : './extract.worker.js', import.meta.url),
    execArgv: fromSource ? ['--import', 'tsx'] : [],
  };
}
