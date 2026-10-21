import { serveExtractions } from '../../extraction-worker.js';

/**
 * An extraction worker serving parsers that misbehave in each of the ways a
 * real one can, by extension — for `extract-in-worker.test.ts`.
 */
serveExtractions({
  // The incident's shape: a rejection nothing awaits, and a promise that never settles.
  '.dangling': () => {
    void Promise.reject(new Error('XRefEntryException: Bad (uncompressed) XRef entry'));
    return new Promise(() => {});
  },
  // Answers, then leaves a rejection behind after the answer.
  '.straggler': () => {
    setTimeout(() => void Promise.reject(new Error('late')), 20);
    return { ok: true, summary: 'straggler', text: 'answered first' };
  },
  '.throw': () => {
    throw new Error('boom');
  },
  // Spins on the worker's thread: only terminating the worker stops it.
  '.hang': () => {
    for (;;) {
      /* a parser in a loop */
    }
  },
  // The parser itself did not load: the reader's fault, not the file's.
  '.transient': () => ({ ok: false, transient: true, message: 'could not be read: the PDF reader did not load (gone)' }),
  '.exit': () => process.exit(3),
  '.echo': (bytes) => ({ ok: true, summary: 'echo', text: bytes.toString('utf8') }),
  // Answers after a while: long enough for an earlier job's straggler to land during it.
  '.slow-echo': (bytes) =>
    new Promise((resolve) => setTimeout(() => resolve({ ok: true, summary: 'echo', text: bytes.toString('utf8') }), 150)),
});
