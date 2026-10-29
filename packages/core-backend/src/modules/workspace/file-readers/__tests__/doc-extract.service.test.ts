import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocExtractService, TIMEOUT_MEMORY_MS, type UnreadableDocument } from '../doc-extract.service.js';
import type { IDocumentExtractor, IsolatedExtraction } from '../document-extractor.contract.js';
import { WorkerDocumentExtractor } from '../extract-in-worker.js';
import { xrefPdf } from './fixtures/damaged-pdf.js';

/**
 * What `DocExtractService` remembers about a failed extraction, and whom it
 * tells: a parser's refusal for good, a timeout or crash for an hour, "busy"
 * not at all; a fresh failure reported once, a remembered one never.
 */

/** An extractor that answers what each test scripts, and counts the extractions it was asked for. */
function scriptedExtractor(answer: (extension: string, bytes: Buffer) => IsolatedExtraction): IDocumentExtractor & { calls: number } {
  return {
    calls: 0,
    async extract(extension, bytes) {
      this.calls++;
      return answer(extension, bytes);
    },
    close: async () => {},
  };
}

const TIMEOUT: IsolatedExtraction = {
  ok: false,
  failure: 'timeout',
  message: 'could not be read: extracting its text took longer than 10 seconds',
};
const ORIGIN = { workspaceId: 'main' };

let cacheRoot = '';
let clock = 0;
let told: UnreadableDocument[] = [];
const now = () => clock;
const onUnreadable = (doc: UnreadableDocument) => told.push(doc);

beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'doc-extract-service-'));
  clock = 1_800_000_000_000;
  told = [];
});
afterEach(() => rm(cacheRoot, { recursive: true, force: true }));

describe('DocExtractService — a damaged PDF, through the real worker', () => {
  let extractor: WorkerDocumentExtractor;
  beforeEach(() => {
    extractor = new WorkerDocumentExtractor();
  });
  afterEach(() => extractor.close());

  it('is extracted once; every later read and the cheap lookup answer the remembered notice', async () => {
    let extractions = 0;
    const counting: IDocumentExtractor = {
      extract: (ext, bytes) => {
        extractions++;
        return extractor.extract(ext, bytes);
      },
      close: () => extractor.close(),
    };
    const service = new DocExtractService(cacheRoot, counting, { now, onUnreadable });
    const pdf = xrefPdf('Hello', { damage: true });
    const first = await service.extract('kb/Supplier-Agreement.pdf', pdf, ORIGIN);
    expect(first).toEqual({ ok: false, message: "could not extract the PDF's text (Bad (uncompressed) XRef entry: 4R)" });
    expect(await service.extract('kb/Supplier-Agreement.pdf', pdf, ORIGIN)).toEqual(first);
    expect(await service.getCached('kb/Supplier-Agreement.pdf', pdf)).toEqual(first);
    expect(extractions).toBe(1);
    // Told once, for the fresh failure only — under the reason the explorer shows.
    expect(told).toEqual([
      { workspaceId: 'main', path: 'kb/Supplier-Agreement.pdf', reason: "could not extract the PDF's text (Bad (uncompressed) XRef entry: 4R)" },
    ]);
  });

  it('extracts the repaired file — new content — and reads it normally', async () => {
    const service = new DocExtractService(cacheRoot, extractor, { now, onUnreadable });
    await service.extract('a.pdf', xrefPdf('Hello', { damage: true }), ORIGIN);
    const repaired = await service.extract('a.pdf', xrefPdf('Hello', { damage: false }), ORIGIN);
    expect(repaired).toMatchObject({ ok: true, text: '[page 1]\nHello' });
  });
});

describe('DocExtractService — how long a failure is remembered', () => {
  it('remembers a parser failure for good — even long past an hour', async () => {
    const extractor = scriptedExtractor(() => ({ ok: false, failure: 'parser', message: 'could not be parsed as a PDF (x)' }));
    const service = new DocExtractService(cacheRoot, extractor, { now });
    const bytes = Buffer.from('damaged');
    await service.extract('a.pdf', bytes);
    clock += 30 * TIMEOUT_MEMORY_MS;
    expect(await service.extract('a.pdf', bytes)).toEqual({ ok: false, message: 'could not be parsed as a PDF (x)' });
    expect(extractor.calls).toBe(1);
  });

  it('remembers a timeout for one hour, then extracts again', async () => {
    let answer: IsolatedExtraction = TIMEOUT;
    const extractor = scriptedExtractor(() => answer);
    const service = new DocExtractService(cacheRoot, extractor, { now, onUnreadable });
    const bytes = Buffer.from('slow');
    expect(await service.extract('big.pdf', bytes, ORIGIN)).toEqual({ ok: false, message: TIMEOUT.message });
    // Within the hour: the notice, at once, from every read and from the cheap lookup.
    clock += TIMEOUT_MEMORY_MS - 1;
    expect(await service.extract('big.pdf', bytes, ORIGIN)).toEqual({ ok: false, message: TIMEOUT.message });
    expect(await service.getCached('big.pdf', bytes)).toEqual({ ok: false, message: TIMEOUT.message });
    expect(extractor.calls).toBe(1);
    // After it: tried again, and this time the server had the moment to spare.
    clock += 1;
    expect(await service.getCached('big.pdf', bytes)).toBeUndefined();
    answer = { ok: true, summary: '1 page', text: '[page 1]\nfinally' };
    expect(await service.extract('big.pdf', bytes, ORIGIN)).toMatchObject({ ok: true, text: '[page 1]\nfinally' });
    expect(extractor.calls).toBe(2);
    expect(told).toEqual([{ workspaceId: 'main', path: 'big.pdf', reason: 'extracting its text took longer than 10 seconds' }]);
  });

  it('remembers a crashed extraction for an hour, like a timeout', async () => {
    const extractor = scriptedExtractor(() => ({ ok: false, failure: 'crashed', message: 'could not be read: its extraction stopped unexpectedly (exit code 3)' }));
    const service = new DocExtractService(cacheRoot, extractor, { now });
    const bytes = Buffer.from('oom');
    await service.extract('a.pdf', bytes);
    await service.extract('a.pdf', bytes);
    expect(extractor.calls).toBe(1);
    clock += TIMEOUT_MEMORY_MS;
    await service.extract('a.pdf', bytes);
    expect(extractor.calls).toBe(2);
  });

  it('remembers nothing, and tells no one, when no worker was free', async () => {
    const extractor = scriptedExtractor(() => ({ ok: false, failure: 'busy', message: 'could not be read: too many documents are being extracted at once; try again in a few seconds' }));
    const service = new DocExtractService(cacheRoot, extractor, { now, onUnreadable });
    const bytes = Buffer.from('fine');
    expect((await service.extract('a.pdf', bytes, ORIGIN)).ok).toBe(false);
    expect(await service.getCached('a.pdf', bytes)).toBeUndefined();
    await service.extract('a.pdf', bytes, ORIGIN);
    expect(extractor.calls).toBe(2);
    expect(told).toEqual([]);
  });

  it('tells no one about a failure of a read with no origin', async () => {
    const extractor = scriptedExtractor(() => TIMEOUT);
    const service = new DocExtractService(cacheRoot, extractor, { now, onUnreadable });
    await service.extract('a.pdf', Buffer.from('x'));
    expect(told).toEqual([]);
  });

  it('tells once when two reads of the same document fail together', async () => {
    const extractor = scriptedExtractor(() => TIMEOUT);
    const service = new DocExtractService(cacheRoot, extractor, { now, onUnreadable });
    const bytes = Buffer.from('twice');
    await Promise.all([service.extract('a.pdf', bytes, ORIGIN), service.extract('a.pdf', bytes, ORIGIN)]);
    expect(extractor.calls).toBe(1);
    expect(told).toHaveLength(1);
  });

  it('two reads of the same bytes at different paths share one extraction, and each marker names its own path', async () => {
    const extractor = scriptedExtractor(() => ({ ok: true, summary: '1 page', text: '[page 1]\nshared' }));
    const service = new DocExtractService(cacheRoot, extractor, { now, onUnreadable });
    const bytes = Buffer.from('same bytes, two names');
    const [a, b] = await Promise.all([service.extract('a/deck.pdf', bytes, ORIGIN), service.extract('b/copy.pdf', bytes, ORIGIN)]);
    expect(extractor.calls).toBe(1);
    expect(a).toEqual({ ok: true, marker: '[extracted text of a/deck.pdf — 1 page]', text: '[page 1]\nshared' });
    expect(b).toEqual({ ok: true, marker: '[extracted text of b/copy.pdf — 1 page]', text: '[page 1]\nshared' });
  });

  it('still answers the read when whoever is told throws', async () => {
    const extractor = scriptedExtractor(() => TIMEOUT);
    const service = new DocExtractService(cacheRoot, extractor, {
      now,
      onUnreadable: () => {
        throw new Error('listener broke');
      },
    });
    expect(await service.extract('a.pdf', Buffer.from('x'), ORIGIN)).toEqual({ ok: false, message: TIMEOUT.message });
  });
});
