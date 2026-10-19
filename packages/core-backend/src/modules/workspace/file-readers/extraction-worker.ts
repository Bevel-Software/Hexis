import { parentPort } from 'node:worker_threads';
import type { ExtractFn, ExtractResult } from './doc-extract.types.js';

/** One job, host → worker: the bytes (transferred, not copied) and the format to read them as. */
export interface ExtractionJob {
  id: number;
  extension: string;
  bytes: Uint8Array;
}

/**
 * One answer, worker → host. `retire` says the worker must not run another
 * job: a parser left a promise rejected behind it, so its state is no longer
 * something a next job should inherit.
 */
export type ExtractionReply = { id: number; retire?: true } & ExtractResult;

/**
 * The worker side of document extraction: answer each job with what its
 * format's extractor returns, ONE job at a time.
 *
 * A parser is contracted to answer for bad content rather than throw, but it
 * is third-party code: one that throws is answered as the job's failure, and
 * one that rejects a promise nobody awaits — pdf.js did, on a damaged
 * cross-reference table, and took a whole server down with it (2026-10-15) —
 * is caught HERE, in the worker's own process events, and answered as the
 * job's failure with that rejection's message. Nothing a parser does reaches
 * the server's process: the worker's events are the worker's.
 *
 * A rejection that arrives after the job was answered has nothing left to
 * fail; the worker ends itself instead of carrying it into the next job.
 */
export function serveExtractions(extractors: Readonly<Record<string, ExtractFn>>): void {
  const port = parentPort;
  if (!port) throw new Error('serveExtractions runs inside a worker thread.');
  let current: number | undefined;

  const answer = (reply: ExtractionReply): void => {
    if (current !== reply.id) return; // already answered — by a dangling rejection, say
    current = undefined;
    port.postMessage(reply);
  };
  const failCurrent = (reason: unknown): void => {
    // A straggler from a job already answered: this worker's parser state is
    // no longer to be trusted, and left running it could pin the rejection on
    // the NEXT job's file. It ends itself; the pool replaces it.
    if (current === undefined) process.exit(0);
    answer({ id: current, ok: false, message: couldNotBeExtracted(reason), retire: true });
  };
  process.on('unhandledRejection', failCurrent);
  process.on('uncaughtException', failCurrent);

  port.on('message', (job: ExtractionJob) => {
    current = job.id;
    void (async () => {
      let result: ExtractResult;
      try {
        const extract = extractors[job.extension];
        result = extract
          ? await extract(Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength))
          : { ok: false, message: `could not be extracted (no extractor reads "${job.extension}" files)` };
      } catch (err) {
        result = { ok: false, message: couldNotBeExtracted(err) };
      }
      answer({ id: job.id, ...result });
    })();
  });
}

/** The notice a parser's own error earns: the same words a thrown extractor always earned in `read_file`. */
function couldNotBeExtracted(reason: unknown): string {
  return `could not be extracted (${reason instanceof Error ? reason.message : String(reason)})`;
}
