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
  // Answers, then — once the host has had time to hand the worker its next
  // job — leaves a rejection behind before that job's message is taken up:
  // the worker sees it BETWEEN jobs, and ends itself.
  '.straggler-between-jobs': () => {
    setImmediate(() => {
      const until = Date.now() + 200;
      while (Date.now() < until) {
        /* the host answers, releases this worker and posts the next job meanwhile */
      }
      void Promise.reject(new Error('late, between jobs'));
    });
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
  '.transient': () => ({ ok: false, transient: true, message: 'could not be read: the PDF reader did not load on the server; try again later' }),
  '.exit': () => process.exit(3),
  '.echo': (bytes) => ({ ok: true, summary: 'echo', text: bytes.toString('utf8') }),
  // Answers after a while: long enough for an earlier job's straggler to land during it.
  '.slow-echo': (bytes) =>
    new Promise((resolve) => setTimeout(() => resolve({ ok: true, summary: 'echo', text: bytes.toString('utf8') }), 150)),
  // Answers, then leaves a rejection behind well into the next job — late
  // enough that the budget the next job has left is less than that job needs.
  '.straggler-late': () => {
    setTimeout(() => void Promise.reject(new Error('late')), 600);
    return { ok: true, summary: 'straggler', text: 'answered first' };
  },
  // A sound document that takes most of a budget: more than what is left
  // after `.straggler-late` lands, less than the budget whole.
  '.slow-echo-long': (bytes) =>
    new Promise((resolve) => setTimeout(() => resolve({ ok: true, summary: 'echo', text: bytes.toString('utf8') }), 1100)),
});
