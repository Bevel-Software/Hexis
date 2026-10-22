import type { ExtractedDoc } from './doc-extract.types.js';

/**
 * The contract for running a document's extractor: what `DocExtractService`
 * depends on, so it never holds a concrete engine. The one implementation is
 * `WorkerDocumentExtractor` (`extract-in-worker.ts`), owned by the
 * composition root and closed with the graph.
 *
 * A parser can hang on crafted input and can reject promises it never hands
 * back, so an implementation must never run one on the request thread, must
 * stop an extraction that outlives its budget, and must answer every failure
 * — a parser error, a dangling rejection, a crash — as an outcome, never as a
 * rejection of `extract` and never as an event on the server's process.
 */
export interface IDocumentExtractor {
  /** Extract `bytes` as a file of `extension` (lowercased, with its dot). The caller's buffer is left as it was. */
  extract(extension: string, bytes: Buffer): Promise<IsolatedExtraction>;
  /** Ends the workers; an extraction after this is answered `busy`. */
  close(): Promise<void>;
}

/**
 * Why an extraction failed, which is what decides how long the failure is
 * remembered (see `DocExtractService`):
 *  - `parser`: the parser refused the bytes, threw, or left a rejection behind
 *    it — a property of the content;
 *  - `timeout`: the extraction outlived its budget and was stopped;
 *  - `crashed`: the worker failed or died under the job without answering
 *    (out of memory, a script that would not load), or the parser itself did
 *    not load — a fault of the moment;
 *  - `busy`: no worker could take the job — nothing was learned about the file.
 */
export type ExtractionFailure = 'parser' | 'timeout' | 'crashed' | 'busy';

export type IsolatedExtraction =
  | ({ ok: true } & ExtractedDoc)
  | { ok: false; message: string; failure: ExtractionFailure };

/** The notice an extraction stopped over its budget answers with. */
export function extractionTimeoutNotice(budgetMs: number): string {
  return `could not be read: extracting its text took longer than ${budgetMs / 1000} seconds`;
}
