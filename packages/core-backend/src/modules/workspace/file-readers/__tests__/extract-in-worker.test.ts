import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractionTimeoutNotice } from '../document-extractor.contract.js';
import { extractDocx } from '../extract-docx.js';
import { EXTRACTION_BUDGET_MS, WorkerDocumentExtractor, type ExtractionWorkerEntry } from '../extract-in-worker.js';
import { extractPdf } from '../extract-pdf.js';
import { xrefPdf } from './fixtures/damaged-pdf.js';

/**
 * The extraction worker kind: every document's extractor runs in a pooled
 * worker thread under a budget, and nothing a parser does — an error, a
 * rejection it never hands back, a loop, a crash — reaches this process.
 */

/** A worker module from this suite's fixtures, loaded as the suites are (TypeScript, through tsx). */
function fixtureEntry(name: string): ExtractionWorkerEntry {
  return { url: new URL(`./fixtures/${name}`, import.meta.url), execArgv: ['--import', 'tsx'] };
}

/** Every unhandled rejection and uncaught exception THIS process sees while a test runs. */
let processSaw: unknown[] = [];
const onRejection = (reason: unknown) => processSaw.push(reason);
const onException = (err: unknown) => processSaw.push(err);
beforeEach(() => {
  processSaw = [];
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
});
afterEach(() => {
  process.off('unhandledRejection', onRejection);
  process.off('uncaughtException', onException);
});

describe('WorkerDocumentExtractor — the real document extractors', () => {
  let extractor: WorkerDocumentExtractor;
  beforeEach(() => {
    extractor = new WorkerDocumentExtractor();
  });
  afterEach(() => extractor.close());

  it('budgets ten seconds per file by default, and words a timeout as the ticket does', () => {
    expect(EXTRACTION_BUDGET_MS).toBe(10_000);
    expect(extractionTimeoutNotice(EXTRACTION_BUDGET_MS)).toBe(
      'could not be read: extracting its text took longer than 10 seconds',
    );
  });

  it('answers a PDF with a damaged cross-reference table with pdf.js’s own message, as a parser failure', async () => {
    const res = await extractor.extract('.pdf', xrefPdf('Hello', { damage: true }));
    expect(res).toEqual({
      ok: false,
      failure: 'parser',
      message: "could not extract the PDF's text (Bad (uncompressed) XRef entry: 4R)",
    });
    // Long enough for any rejection pdf.js left behind to have surfaced.
    await new Promise((r) => setTimeout(r, 50));
    expect(processSaw).toEqual([]);
  });

  it('extracts a sound document exactly as the extractor does on its own — same text, same summary', async () => {
    const pdf = xrefPdf('Hello PDF world', { damage: false });
    const docx = await readFile(new URL('./fixtures/tab.docx', import.meta.url));
    const inProcess = [await extractPdf(pdf), await extractDocx(docx)];
    const inWorker = [await extractor.extract('.pdf', pdf), await extractor.extract('.docx', docx)];
    expect(inWorker).toEqual(inProcess);
    expect(inWorker[0]).toMatchObject({ ok: true, text: '[page 1]\nHello PDF world' });
  });

  it('leaves the caller’s buffer as it was — the worker gets a copy', async () => {
    const pdf = xrefPdf('Keep me', { damage: false });
    const before = Buffer.from(pdf);
    await extractor.extract('.pdf', pdf);
    expect(pdf.byteLength).toBe(before.byteLength);
    expect(pdf.equals(before)).toBe(true);
  });
});

describe('WorkerDocumentExtractor — a parser that misbehaves', () => {
  let extractor: WorkerDocumentExtractor;
  afterEach(() => extractor.close());

  it('turns a rejection the parser never hands back into the job’s failure — this process sees none', async () => {
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('misbehaving-extract.worker.ts') });
    const res = await extractor.extract('.dangling', Buffer.from('x'));
    expect(res).toEqual({
      ok: false,
      failure: 'parser',
      message: 'could not be extracted (XRefEntryException: Bad (uncompressed) XRef entry)',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(processSaw).toEqual([]);
    // The worker it happened in is retired; the next job gets a sound one.
    expect(await extractor.extract('.echo', Buffer.from('after'))).toMatchObject({ ok: true, text: 'after' });
  });

  it('keeps a rejection left behind AFTER an answer out of this process and out of the next job', async () => {
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('misbehaving-extract.worker.ts'), poolMax: 1 });
    expect(await extractor.extract('.straggler', Buffer.from('x'))).toMatchObject({ ok: true, text: 'answered first' });
    await new Promise((r) => setTimeout(r, 100));
    expect(await extractor.extract('.echo', Buffer.from('next'))).toMatchObject({ ok: true, text: 'next' });
    expect(processSaw).toEqual([]);
  });

  it('never pins an earlier job’s late rejection on the job the worker runs next — reused at once', async () => {
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('misbehaving-extract.worker.ts'), poolMax: 1 });
    expect(await extractor.extract('.straggler', Buffer.from('x'))).toMatchObject({ ok: true, text: 'answered first' });
    // No pause: the one worker gets this job straight away, and the straggler lands while it runs.
    expect(await extractor.extract('.slow-echo', Buffer.from('mine'))).toEqual({ ok: true, summary: 'echo', text: 'mine' });
    expect(processSaw).toEqual([]);
  });

  it('still pins a rejection on its own job when the worker had served another first', async () => {
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('misbehaving-extract.worker.ts'), poolMax: 1 });
    expect(await extractor.extract('.echo', Buffer.from('warm'))).toMatchObject({ ok: true });
    expect(await extractor.extract('.dangling', Buffer.from('x'))).toEqual({
      ok: false,
      failure: 'parser',
      message: 'could not be extracted (XRefEntryException: Bad (uncompressed) XRef entry)',
    });
    expect(await extractor.extract('.echo', Buffer.from('after'))).toMatchObject({ ok: true, text: 'after' });
    expect(processSaw).toEqual([]);
  });

  it('answers a parser that throws with its message', async () => {
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('misbehaving-extract.worker.ts') });
    expect(await extractor.extract('.throw', Buffer.from('x'))).toEqual({
      ok: false,
      failure: 'parser',
      message: 'could not be extracted (boom)',
    });
  });

  it('terminates a parser past its budget and answers the timeout notice — while this thread stays free', async () => {
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('misbehaving-extract.worker.ts'), budgetMs: 300 });
    // Warm the worker so its start-up is not part of the budget measured below.
    await extractor.extract('.echo', Buffer.from('warm'));
    const started = Date.now();
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 20);
    const res = await extractor.extract('.hang', Buffer.from('x'));
    clearInterval(ticker);
    expect(res).toEqual({
      ok: false,
      failure: 'timeout',
      message: 'could not be read: extracting its text took longer than 0.3 seconds',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    // The loop ran on the worker's thread: this one kept turning the whole time.
    expect(ticks).toBeGreaterThan(5);
    expect(await extractor.extract('.echo', Buffer.from('again'))).toMatchObject({ ok: true, text: 'again' });
  });

  it('gives three documents at once a worker and a budget each', async () => {
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('misbehaving-extract.worker.ts'), budgetMs: 500 });
    await Promise.all([1, 2, 3].map(() => extractor.extract('.echo', Buffer.from('warm'))));
    const started = Date.now();
    const results = await Promise.all([1, 2, 3].map(() => extractor.extract('.hang', Buffer.from('x'))));
    expect(results.map((r) => !r.ok && r.failure)).toEqual(['timeout', 'timeout', 'timeout']);
    // Side by side, not one after another: none waited a budget for a worker.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('answers a worker that dies under the job as crashed, and one that cannot load the same way', async () => {
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('misbehaving-extract.worker.ts') });
    expect(await extractor.extract('.exit', Buffer.from('x'))).toEqual({
      ok: false,
      failure: 'crashed',
      message: 'could not be read: its extraction stopped unexpectedly (exit code 3)',
    });
    await extractor.close();
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('unloadable-extract.worker.ts') });
    const res = await extractor.extract('.pdf', Buffer.from('x'));
    expect(res.ok).toBe(false);
    expect(!res.ok && res.failure).toBe('crashed');
    expect(!res.ok && res.message).toContain('this worker cannot load');
    expect(processSaw).toEqual([]);
  });

  it('answers a parser that did not load as crashed — remembered for the hour, not for good', async () => {
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('misbehaving-extract.worker.ts') });
    expect(await extractor.extract('.transient', Buffer.from('x'))).toEqual({
      ok: false,
      failure: 'crashed',
      message: 'could not be read: the PDF reader did not load (gone)',
    });
  });

  it('answers busy — nothing learned about the file — when every worker is taken and no one may wait', async () => {
    extractor = new WorkerDocumentExtractor({
      entry: fixtureEntry('misbehaving-extract.worker.ts'),
      budgetMs: 500,
      poolMax: 1,
      maxWaiting: 0,
    });
    const hanging = extractor.extract('.hang', Buffer.from('x'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await extractor.extract('.echo', Buffer.from('y'))).toMatchObject({ ok: false, failure: 'busy' });
    expect(await hanging).toMatchObject({ failure: 'timeout' });
  });

  it('answers busy for an extraction running when the graph stops', async () => {
    extractor = new WorkerDocumentExtractor({ entry: fixtureEntry('misbehaving-extract.worker.ts'), budgetMs: 5_000 });
    const hanging = extractor.extract('.hang', Buffer.from('x'));
    await new Promise((r) => setTimeout(r, 300));
    await extractor.close();
    expect(await hanging).toMatchObject({ ok: false, failure: 'busy' });
  });
});
