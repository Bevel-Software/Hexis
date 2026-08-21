import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractDocx } from '../extract-docx.js';
import { extractPptx } from '../extract-pptx.js';
import { extractXlsx } from '../extract-xlsx.js';
import { extractPdf } from '../extract-pdf.js';
import { DocExtractService } from '../doc-extract.service.js';
import { gitBlobSha } from '../extraction-cache.js';
import { fileExtension, isLegacyDocument, isSupportedDocument } from '../doc-extract.types.js';

/**
 * REAL fixtures, no mocks: docx/pptx are handcrafted OOXML zips built with
 * adm-zip in-test, xlsx comes out of SheetJS itself, and the PDF is a minimal
 * one-page document assembled byte-for-byte (valid xref included).
 */

// ── fixture builders ───────────────────────────────────────────────────────

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

function docxBytes(bodyXml: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
  );
  zip.addFile(
    'word/document.xml',
    Buffer.from(`<?xml version="1.0"?><w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`),
  );
  return zip.toBuffer();
}

const para = (...runs: string[]): string =>
  `<w:p>${runs.map((r) => `<w:r><w:t>${r}</w:t></w:r>`).join('')}</w:p>`;

function slideXml(...paragraphs: string[][]): string {
  const ps = paragraphs
    .map((runs) => `<a:p>${runs.map((r) => `<a:r><a:t>${r}</a:t></a:r>`).join('')}</a:p>`)
    .join('');
  return `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ${A_NS}><p:txBody>${ps}</p:txBody></p:sld>`;
}

function pptxBytes(slides: Record<number, string>, notes: Record<number, string> = {}): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  for (const [n, xml] of Object.entries(slides)) zip.addFile(`ppt/slides/slide${n}.xml`, Buffer.from(xml));
  for (const [n, xml] of Object.entries(notes)) zip.addFile(`ppt/notesSlides/notesSlide${n}.xml`, Buffer.from(xml));
  return zip.toBuffer();
}

function xlsxBytes(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** A minimal but VALID one-page PDF whose text layer is `text` ('' = no text layer). */
export function pdfBytes(text: string): Buffer {
  const stream = text === '' ? '' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ── extension classification ───────────────────────────────────────────────

describe('document type classification', () => {
  it('recognises the four supported types, case-insensitively', () => {
    for (const p of ['a.docx', 'Plugins/GTM/Deck.PPTX', 'x/y.xlsx', 'r.pdf']) {
      expect(isSupportedDocument(p), p).toBe(true);
    }
  });
  it('legacy formats and everything else are not supported', () => {
    for (const p of ['a.doc', 'a.ppt', 'a.xls', 'a.md', 'a.zip', 'noext', '.docx']) {
      expect(isSupportedDocument(p), p).toBe(false);
    }
    expect(isLegacyDocument('old.doc')).toBe(true);
    expect(isLegacyDocument('new.docx')).toBe(false);
  });
  it('fileExtension lowercases and ignores dot-files', () => {
    expect(fileExtension('A/B/C.DocX')).toBe('.docx');
    expect(fileExtension('dir/.gitignore')).toBe('');
  });
});

// ── docx ───────────────────────────────────────────────────────────────────

describe('extractDocx', () => {
  it('joins split runs with NO separator and emits paragraphs as lines', () => {
    const res = extractDocx(docxBytes(para('Hel', 'lo world') + para('Second paragraph')));
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['Hello world', 'Second paragraph']);
    expect(res.summary).toContain('2 paragraphs');
    expect(res.summary).toContain('headers/footers skipped');
  });

  it('decodes named and numeric XML entities', () => {
    const res = extractDocx(docxBytes(para('&amp; &lt;tag&gt; &quot;q&quot; &apos;a&apos; &#65;&#x42;')));
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('& <tag> "q" \'a\' AB');
  });

  it('renders table rows as tab-separated cell text, without double-counting their paragraphs', () => {
    const table =
      '<w:tbl><w:tblPr/>' +
      `<w:tr><w:tc>${para('A1')}</w:tc><w:tc>${para('B1')}</w:tc></w:tr>` +
      `<w:tr><w:tc>${para('A2')}</w:tc><w:tc>${para('B2')}</w:tc></w:tr>` +
      '</w:tbl>';
    const res = extractDocx(docxBytes(para('Before') + table + para('After')));
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['Before', 'A1\tB1', 'A2\tB2', 'After']);
    expect(res.summary).toContain('1 table');
  });

  it('returns a typed failure for bytes that are not a zip', () => {
    const res = extractDocx(Buffer.from('this is not a docx at all'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('could not be parsed as a .docx');
  });

  it('returns a typed failure for a zip without word/document.xml', () => {
    const zip = new AdmZip();
    zip.addFile('hello.txt', Buffer.from('hi'));
    const res = extractDocx(zip.toBuffer());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('no word/document.xml');
  });
});

// ── pptx ───────────────────────────────────────────────────────────────────

describe('extractPptx', () => {
  it('emits [slide N] markers in NUMERIC order with per-paragraph lines and notes', () => {
    const res = extractPptx(
      pptxBytes(
        {
          2: slideXml(['Second slide']),
          10: slideXml(['Tenth slide']),
          1: slideXml(['Road', 'map 2026'], ['Bullet one']),
        },
        { 1: slideXml(['Remember the demo']) },
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual([
      '[slide 1]',
      'Roadmap 2026',
      'Bullet one',
      '[slide 1 notes]',
      'Remember the demo',
      '[slide 2]',
      'Second slide',
      '[slide 10]',
      'Tenth slide',
    ]);
    expect(res.summary).toContain('3 slides + notes');
  });

  it('omits the notes marker when the notes part has no text, and "+ notes" from the summary', () => {
    const res = extractPptx(pptxBytes({ 1: slideXml(['Only slide']) }, { 1: slideXml([]) }));
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('[slide 1]\nOnly slide');
    expect(res.summary).toContain('1 slide;');
  });

  it('returns a typed failure for a zip with no slides', () => {
    const zip = new AdmZip();
    zip.addFile('ppt/presentation.xml', Buffer.from('<p/>'));
    const res = extractPptx(zip.toBuffer());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('could not be parsed as a .pptx');
  });
});

// ── xlsx ───────────────────────────────────────────────────────────────────

describe('extractXlsx', () => {
  it('emits [sheet: Name] markers and rows as tab-separated values', () => {
    const res = extractXlsx(
      xlsxBytes({
        Inventory: [
          ['Name', 'Qty'],
          ['Widget', 3],
        ],
        Empty: [[]],
      }),
    );
    if (!res.ok) throw new Error(res.message);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('[sheet: Inventory]');
    expect(lines[1]).toBe('Name\tQty');
    expect(lines[2]).toBe('Widget\t3');
    expect(lines).toContain('[sheet: Empty]');
    expect(res.summary).toContain('2 sheets');
  });

  it('refuses non-zip bytes instead of letting SheetJS misread them as CSV', () => {
    const res = extractXlsx(Buffer.from('a,b,c\n1,2,3\n'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('not a zip archive');
  });
});

// ── pdf ────────────────────────────────────────────────────────────────────

describe('extractPdf', () => {
  it('extracts the text layer with [page N] markers', async () => {
    const res = await extractPdf(pdfBytes('Hello PDF world'));
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[page 1]', 'Hello PDF world']);
    expect(res.summary).toContain('1 page');
  });

  it('says "no text layer" for a page without one (scan-style PDF)', async () => {
    const res = await extractPdf(pdfBytes(''));
    if (!res.ok) throw new Error(res.message);
    expect(res.summary).toContain('no text layer (scanned document?)');
    expect(res.text).toBe('[page 1]');
  });

  it('returns a typed failure for bytes that are not a PDF', async () => {
    const res = await extractPdf(Buffer.from('definitely not a pdf'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('could not be parsed as a PDF');
  });
});

// ── cache + service ────────────────────────────────────────────────────────

describe('DocExtractService cache', () => {
  let cacheRoot = '';
  let service: DocExtractService;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'doc-extract-cache-'));
    service = new DocExtractService(cacheRoot);
  });
  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('extracts ONCE per content: the second read is served from the cache file', async () => {
    const bytes = docxBytes(para('Cache me once'));
    const first = await service.extract('a.docx', bytes);
    expect(first.ok).toBe(true);
    const entries = await readdir(cacheRoot);
    expect(entries).toEqual([`${gitBlobSha(bytes)}.json`]);

    // Tamper with the cached entry: if the second extract returns the tampered
    // text, it came from the cache — the parser did NOT run again. (Real-files
    // proof without spying on module internals.)
    await writeFile(join(cacheRoot, entries[0]), JSON.stringify({ summary: 'tampered summary', text: 'FROM CACHE' }), 'utf8');
    const second = await service.extract('a.docx', bytes);
    if (!second.ok) throw new Error(second.message);
    expect(second.text).toBe('FROM CACHE');
    expect(second.marker).toBe('[extracted text of a.docx — tampered summary]');
  });

  it('is invalidated by CONTENT change (new blob sha → fresh extraction, new entry)', async () => {
    const v1 = docxBytes(para('version one'));
    const v2 = docxBytes(para('version two'));
    await service.extract('a.docx', v1);
    const after1 = await readdir(cacheRoot);
    const res = await service.extract('a.docx', v2);
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('version two');
    const after2 = await readdir(cacheRoot);
    expect(after2).toHaveLength(2);
    expect(after2).toEqual(expect.arrayContaining(after1));
  });

  it('keys by content, not path: the same bytes under another path reuse the entry, marker names the read path', async () => {
    const bytes = docxBytes(para('Shared content'));
    await service.extract('one.docx', bytes);
    expect(await readdir(cacheRoot)).toHaveLength(1);
    const other = await service.extract('two/other.docx', bytes);
    if (!other.ok) throw new Error(other.message);
    expect(other.marker).toMatch(/^\[extracted text of two\/other\.docx — /);
    expect(await readdir(cacheRoot)).toHaveLength(1);
  });

  it('getCached misses before extraction and hits after — the grep budget contract', async () => {
    const bytes = docxBytes(para('Budget line'));
    expect(await service.getCached('a.docx', bytes)).toBeUndefined();
    await service.extract('a.docx', bytes);
    const hit = await service.getCached('a.docx', bytes);
    expect(hit?.text).toBe('Budget line');
  });

  it('does NOT cache failures — a corrupt file is re-tried on the next read', async () => {
    const res = await service.extract('bad.docx', Buffer.from('junk'));
    expect(res.ok).toBe(false);
    expect(await readdir(cacheRoot)).toHaveLength(0);
  });

  it('computes the git blob sha (matches `git hash-object`)', async () => {
    // echo -n 'hello' | git hash-object --stdin
    expect(gitBlobSha(Buffer.from('hello'))).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  });

  it('the cached entry on disk is the {summary, text} JSON', async () => {
    const bytes = docxBytes(para('On disk'));
    await service.extract('a.docx', bytes);
    const raw = JSON.parse(await readFile(join(cacheRoot, `${gitBlobSha(bytes)}.json`), 'utf8')) as { summary: string; text: string };
    expect(raw.text).toBe('On disk');
    expect(typeof raw.summary).toBe('string');
  });
});
