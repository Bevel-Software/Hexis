import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractDocx } from '../extract-docx.js';
import { extractPptx } from '../extract-pptx.js';
import { extractXlsx } from '../extract-xlsx.js';
import { extractPdf } from '../extract-pdf.js';
import { extractOdt } from '../extract-odt.js';
import { extractOdp } from '../extract-odp.js';
import { extractOds } from '../extract-ods.js';
import { DocExtractService, EXTRACTION_SCHEMA } from '../doc-extract.service.js';
import { DocExtractionCache, gitBlobSha } from '../extraction-cache.js';
import { fileExtension } from '../doc-extract.types.js';
import { MAX_ODF_NS_ALIASES, normalizeOdfPrefixes, odfParagraphBlocks } from '../odf-text.js';
import { decodeXmlEntities, xmlAttrValue, xmlAttrValueByLocalName } from '../ooxml-text.js';
import { notesTargetFromRels } from '../extract-pptx.js';

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

function pptxBytes(
  slides: Record<number, string>,
  notes: Record<number, string> = {},
  extra: Record<string, string> = {},
): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  for (const [n, xml] of Object.entries(slides)) zip.addFile(`ppt/slides/slide${n}.xml`, Buffer.from(xml));
  for (const [n, xml] of Object.entries(notes)) zip.addFile(`ppt/notesSlides/notesSlide${n}.xml`, Buffer.from(xml));
  for (const [name, xml] of Object.entries(extra)) zip.addFile(name, Buffer.from(xml));
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
  return pdfWithContentStream(text === '' ? '' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`);
}

/** The same one-page shell, but the test dictates the page's raw content stream. */
function pdfWithContentStream(stream: string): Buffer {
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

// ── ODF fixture builders ───────────────────────────────────────────────────

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';

function odfBytes(mimetype: string, bodyXml: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from(mimetype));
  zip.addFile(
    'content.xml',
    Buffer.from(`<?xml version="1.0"?><office:document-content ${ODF_NS}><office:body>${bodyXml}</office:body></office:document-content>`),
  );
  return zip.toBuffer();
}

/** An ODF package whose ROOT attributes and whole content tree the test dictates. */
function odfBytesRaw(mimetype: string, rootAttrs: string, contentXml: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from(mimetype));
  zip.addFile(
    'content.xml',
    Buffer.from(`<?xml version="1.0"?><office:document-content ${ODF_NS} ${rootAttrs}>${contentXml}</office:document-content>`),
  );
  return zip.toBuffer();
}

const odtBytes = (textXml: string): Buffer =>
  odfBytes('application/vnd.oasis.opendocument.text', `<office:text>${textXml}</office:text>`);

/** One odp slide: frame paragraphs + optional notes paragraphs. */
const odpPage = (paragraphs: string[], notes: string[] = []): string =>
  '<draw:page draw:name="page">' +
  `<draw:frame><draw:text-box>${paragraphs.map((p) => `<text:p>${p}</text:p>`).join('')}</draw:text-box></draw:frame>` +
  (notes.length > 0
    ? `<presentation:notes><draw:frame><draw:text-box>${notes.map((p) => `<text:p>${p}</text:p>`).join('')}</draw:text-box></draw:frame></presentation:notes>`
    : '') +
  '</draw:page>';

const odpBytes = (...pages: string[]): Buffer =>
  odfBytes('application/vnd.oasis.opendocument.presentation', `<office:presentation>${pages.join('')}</office:presentation>`);

const odsBytes = (...tables: string[]): Buffer =>
  odfBytes('application/vnd.oasis.opendocument.spreadsheet', `<office:spreadsheet>${tables.join('')}</office:spreadsheet>`);

const odsCell = (text: string, repeat?: number): string =>
  `<table:table-cell${repeat ? ` table:number-columns-repeated="${repeat}"` : ''}>${text === '' ? '' : `<text:p>${text}</text:p>`}</table:table-cell>`;

// ── extension parsing ──────────────────────────────────────────────────────
// (Which extension belongs to which reader lives in the registry now — see
// file-reader.registry.test.ts for the routing, case-insensitivity included.)

describe('fileExtension', () => {
  it('lowercases and ignores dot-files', () => {
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

  it('a sheet name holding a tab or newline cannot split the [sheet: …] marker line', () => {
    // Excel's own UI forbids these, but the name is an XML attribute in a
    // crafted workbook — SheetJS round-trips `&#10;` intact. Same rule as the
    // ods extractor: control separators become spaces so grep line numbers hold.
    const res = extractXlsx(xlsxBytes({ 'bad\nname\ttab': [['x']] }));
    if (!res.ok) throw new Error(res.message);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('[sheet: bad name tab]');
    expect(lines[1]).toBe('x');
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

  it('joins same-line items with spaces and breaks lines on a Y jump (items arrive streamed)', async () => {
    // Three separate show-text ops: two on one baseline, one 40pt lower. The
    // extractor consumes them through `streamTextContent` now, so this guards
    // the item walk (space joins, Y-jump line breaks) across chunk boundaries.
    const res = await extractPdf(
      pdfWithContentStream('BT /F1 12 Tf 72 720 Td (Alpha) Tj 60 0 Td (beta) Tj -60 -40 Td (Gamma) Tj ET'),
    );
    if (!res.ok) throw new Error(res.message);
    const lines = res.text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('[page 1]');
    // pdf.js may model the gap as its own whitespace item — spacing WIDTH is
    // its call, but the items must land on one line, space-separated.
    expect(lines[1]).toMatch(/^Alpha +beta$/);
    expect(lines[2]).toBe('Gamma');
  });
});

// ── odt ────────────────────────────────────────────────────────────────────

describe('extractOdt', () => {
  it('joins spans with NO separator; headings and paragraphs are lines in document order', () => {
    const res = extractOdt(
      odtBytes(
        '<text:h text:outline-level="1">Ti<text:span text:style-name="T1">tle</text:span></text:h>' +
          '<text:p>Hel<text:span text:style-name="T2">lo world</text:span></text:p>',
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['Title', 'Hello world']);
    expect(res.summary).toBe('2 paragraphs; layout, images and formatting omitted');
  });

  it('renders <text:tab/>, <text:line-break/> and <text:s text:c="N"/> as real characters', () => {
    const res = extractOdt(odtBytes('<text:p>a<text:tab/>b<text:line-break/>c<text:s text:c="3"/>d<text:s/>e</text:p>'));
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('a\tb\nc   d e');
  });

  it('decodes named and numeric XML entities', () => {
    const res = extractOdt(odtBytes('<text:p>&amp; &lt;tag&gt; &quot;q&quot; &apos;a&apos; &#65;&#x42;</text:p>'));
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('& <tag> "q" \'a\' AB');
  });

  it('returns a typed failure for bytes that are not a zip', () => {
    const res = extractOdt(Buffer.from('this is not an odt at all'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('could not be parsed as a .odt');
  });

  it('returns a typed failure for a zip without content.xml', () => {
    const zip = new AdmZip();
    zip.addFile('hello.txt', Buffer.from('hi'));
    const res = extractOdt(zip.toBuffer());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('no content.xml');
  });
});

// ── odp ────────────────────────────────────────────────────────────────────

describe('extractOdp', () => {
  it('numbers slides by DOCUMENT order of <draw:page>, with notes under [slide N notes]', () => {
    const res = extractOdp(
      odpBytes(
        odpPage(['Road', 'map 2026'], ['Remember the demo']),
        odpPage(['Second slide']),
        odpPage(['Third slide']),
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual([
      '[slide 1]',
      'Road',
      'map 2026',
      '[slide 1 notes]',
      'Remember the demo',
      '[slide 2]',
      'Second slide',
      '[slide 3]',
      'Third slide',
    ]);
    expect(res.summary).toBe('3 slides + notes; layout, images and formatting omitted');
  });

  it('omits the notes marker (and "+ notes") when no slide has note text', () => {
    const res = extractOdp(odpBytes(odpPage(['Only slide'])));
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('[slide 1]\nOnly slide');
    expect(res.summary).toContain('1 slide;');
  });

  it('returns a typed failure for a zip whose content.xml has no draw:page', () => {
    const res = extractOdp(odtBytes('<text:p>not a presentation</text:p>'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('could not be parsed as a .odp');
  });

  it('returns a typed failure for bytes that are not a zip', () => {
    const res = extractOdp(Buffer.from('junk'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('could not be parsed as a .odp');
  });
});

// ── ods ────────────────────────────────────────────────────────────────────

describe('extractOds', () => {
  const row = (...cells: string[]): string => `<table:table-row>${cells.join('')}</table:table-row>`;
  const table = (name: string, ...rows: string[]): string =>
    `<table:table table:name="${name}">${rows.join('')}</table:table>`;

  it('emits [sheet: Name] markers and rows as tab-separated cell text', () => {
    const res = extractOds(
      odsBytes(
        table('Inventory', row(odsCell('Name'), odsCell('Qty')), row(odsCell('Widget'), odsCell('3'))),
        table('Empty'),
      ),
    );
    if (!res.ok) throw new Error(res.message);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('[sheet: Inventory]');
    expect(lines[1]).toBe('Name\tQty');
    expect(lines[2]).toBe('Widget\t3');
    expect(lines).toContain('[sheet: Empty]');
    expect(res.summary).toContain('2 sheets');
  });

  it('expands column/row repeats for real data', () => {
    const res = extractOds(
      odsBytes(
        table(
          'S',
          row(odsCell('x', 3), odsCell('end')),
          `<table:table-row table:number-rows-repeated="2">${odsCell('dup')}</table:table-row>`,
        ),
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[sheet: S]', 'x\tx\tx\tend', 'dup', 'dup']);
  });

  it('TRIMS trailing empty cells/rows before applying their repeats — million-wide grid padding costs nothing', () => {
    const res = extractOds(
      odsBytes(
        table(
          'Padded',
          row(odsCell('a'), odsCell('', 1_000_000)),
          `<table:table-row table:number-rows-repeated="1048576">${odsCell('', 1_000_000)}</table:table-row>`,
        ),
      ),
    );
    if (!res.ok) throw new Error(res.message);
    // No truncation note: the padding was trimmed, not truncated.
    expect(res.text.split('\n')).toEqual(['[sheet: Padded]', 'a']);
  });

  it('caps NON-empty repeats at 200 columns / 10k rows and says so under the sheet marker', () => {
    const res = extractOds(
      odsBytes(
        table(
          'Big',
          row(odsCell('w', 300)),
          `<table:table-row table:number-rows-repeated="20000">${odsCell('r')}</table:table-row>`,
        ),
      ),
    );
    if (!res.ok) throw new Error(res.message);
    const lines = res.text.split('\n');
    expect(lines[1]).toBe('[sheet truncated to the first 10000 rows and first 200 columns]');
    expect(lines[2]).toBe(Array(200).fill('w').join('\t'));
    expect(lines).toHaveLength(2 + 10_000);
  });

  it('the row cap STOPS the scan — 60k explicit rows extract their first 10k, fast', () => {
    // Explicit (non-repeated) rows used to be materialized wholesale before
    // the cap was consulted, so the cap bounded output but neither memory nor
    // scan work. The walk now hands rows over as they parse and stops at the
    // cap. The bound is generous — here to catch a return of the
    // materialize-everything shape, not to police CI's scheduler.
    const bytes = odsBytes(`<table:table table:name="Long">${row(odsCell('r')).repeat(60_000)}</table:table>`);
    const t0 = performance.now();
    const res = extractOds(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    const lines = res.text.split('\n');
    expect(lines[1]).toBe('[sheet truncated to the first 10000 rows]');
    expect(lines).toHaveLength(2 + 10_000);
    expect(ms).toBeLessThan(5_000);
  });

  it('decodes entities in cell text and the sheet name; covered cells render empty', () => {
    const res = extractOds(
      odsBytes(
        table(
          'P&amp;L',
          row(odsCell('A&amp;B'), '<table:covered-table-cell/>', odsCell('C')),
        ),
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[sheet: P&L]', 'A&B\t\tC']);
  });

  it('returns a typed failure for bytes that are not a zip', () => {
    const res = extractOds(Buffer.from('nope'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('could not be parsed as a .ods');
  });

  it('returns a typed failure for a content.xml without table:table', () => {
    const res = extractOds(odtBytes('<text:p>a text document</text:p>'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('no table:table');
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
    const first = await service.extract('a.docx', bytes, extractDocx);
    expect(first.ok).toBe(true);
    const entries = await readdir(cacheRoot);
    expect(entries).toEqual([`${gitBlobSha(bytes)}.docx.${EXTRACTION_SCHEMA}.json`]);

    // Tamper with the cached entry: if the second extract returns the tampered
    // text, it came from the cache — the parser did NOT run again. (Real-files
    // proof without spying on module internals.)
    await writeFile(join(cacheRoot, entries[0]), JSON.stringify({ summary: 'tampered summary', text: 'FROM CACHE' }), 'utf8');
    const second = await service.extract('a.docx', bytes, extractDocx);
    if (!second.ok) throw new Error(second.message);
    expect(second.text).toBe('FROM CACHE');
    expect(second.marker).toBe('[extracted text of a.docx — tampered summary]');
  });

  it('is invalidated by CONTENT change (new blob sha → fresh extraction, new entry)', async () => {
    const v1 = docxBytes(para('version one'));
    const v2 = docxBytes(para('version two'));
    await service.extract('a.docx', v1, extractDocx);
    const after1 = await readdir(cacheRoot);
    const res = await service.extract('a.docx', v2, extractDocx);
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('version two');
    const after2 = await readdir(cacheRoot);
    expect(after2).toHaveLength(2);
    expect(after2).toEqual(expect.arrayContaining(after1));
  });

  it('keys by content, not path: the same bytes under another path reuse the entry, marker names the read path', async () => {
    const bytes = docxBytes(para('Shared content'));
    await service.extract('one.docx', bytes, extractDocx);
    expect(await readdir(cacheRoot)).toHaveLength(1);
    const other = await service.extract('two/other.docx', bytes, extractDocx);
    if (!other.ok) throw new Error(other.message);
    expect(other.marker).toMatch(/^\[extracted text of two\/other\.docx — /);
    expect(await readdir(cacheRoot)).toHaveLength(1);
  });

  it('getCached misses before extraction and hits after — the grep budget contract', async () => {
    const bytes = docxBytes(para('Budget line'));
    expect(await service.getCached('a.docx', bytes)).toBeUndefined();
    await service.extract('a.docx', bytes, extractDocx);
    const hit = await service.getCached('a.docx', bytes);
    expect(hit?.text).toBe('Budget line');
  });

  it('does NOT cache failures — a corrupt file is re-tried on the next read', async () => {
    const res = await service.extract('bad.docx', Buffer.from('junk'), extractDocx);
    expect(res.ok).toBe(false);
    expect(await readdir(cacheRoot)).toHaveLength(0);
  });

  it('computes the git blob sha (matches `git hash-object`)', async () => {
    // echo -n 'hello' | git hash-object --stdin
    expect(gitBlobSha(Buffer.from('hello'))).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  });

  it('the cached entry on disk is the {summary, text} JSON', async () => {
    const bytes = docxBytes(para('On disk'));
    await service.extract('a.docx', bytes, extractDocx);
    const raw = JSON.parse(await readFile(join(cacheRoot, `${gitBlobSha(bytes)}.docx.${EXTRACTION_SCHEMA}.json`), 'utf8')) as { summary: string; text: string };
    expect(raw.text).toBe('On disk');
    expect(typeof raw.summary).toBe('string');
  });

  it('keys by content PLUS format: identical bytes under another extension re-extract, never cross-hit', async () => {
    // One ODF package that both extractors accept: a text body holding a table.
    const bytes = odfBytes(
      'application/vnd.oasis.opendocument.text',
      '<office:text><text:p>Prose line</text:p>' +
        '<table:table table:name="Grid"><table:table-row>' +
        `${odsCell('cell')}` +
        '</table:table-row></table:table></office:text>',
    );
    const asOdt = await service.extract('doc.odt', bytes, extractOdt);
    if (!asOdt.ok) throw new Error(asOdt.message);
    expect(asOdt.text).toContain('Prose line');

    // Same bytes, renamed .ods: the odt extraction must NOT come back.
    const asOds = await service.extract('doc.ods', bytes, extractOds);
    if (!asOds.ok) throw new Error(asOds.message);
    expect(asOds.text.split('\n')[0]).toBe('[sheet: Grid]');
    expect(asOds.marker).toContain('sheet');

    const entries = await readdir(cacheRoot);
    expect(entries.sort()).toEqual([`${gitBlobSha(bytes)}.ods.${EXTRACTION_SCHEMA}.json`, `${gitBlobSha(bytes)}.odt.${EXTRACTION_SCHEMA}.json`].sort());

    // getCached honours the same format-qualified key.
    const cachedOds = await service.getCached('doc.ods', bytes);
    expect(cachedOds?.text.split('\n')[0]).toBe('[sheet: Grid]');
  });
});

// ── cache size bounding ────────────────────────────────────────────────────

describe('DocExtractionCache pruning', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'extract-cache-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const dirTotalBytes = async (): Promise<number> => {
    let total = 0;
    for (const name of await readdir(root)) total += (await stat(join(root, name))).size;
    return total;
  };

  it('prunes towards the byte bound as sequential puts pass it', async () => {
    const cache = new DocExtractionCache(root, 300);
    for (let i = 0; i < 10; i++) await cache.put(`seq${i}`, { summary: 's', text: 'x'.repeat(80) });
    expect(await dirTotalBytes()).toBeLessThanOrEqual(300);
  });

  it('keeps writes that race a prune ACCOUNTED — the next put still prunes to the bound', async () => {
    // Concurrent puts can land while a prune's scan runs; resetting the
    // written-bytes counter to zero after the scan discarded them, so later
    // puts trusted a total the scan never saw and skipped pruning entirely.
    const cache = new DocExtractionCache(root, 300);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => cache.put(`race${i}`, { summary: 's', text: 'y'.repeat(80) })),
    );
    await cache.put('after-the-race', { summary: 's', text: 'z'.repeat(80) });
    expect(await dirTotalBytes()).toBeLessThanOrEqual(300);
  });
});

// ── rels-paired pptx notes ─────────────────────────────────────────────────

describe('extractPptx notes pairing via rels', () => {
  const RELS_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
  const NOTES_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';

  function pptxWithRels(
    slides: Record<number, string>,
    notesParts: Record<string, string>,
    rels: Record<number, string>,
  ): Buffer {
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
    for (const [n, xml] of Object.entries(slides)) zip.addFile(`ppt/slides/slide${n}.xml`, Buffer.from(xml));
    for (const [name, xml] of Object.entries(notesParts)) zip.addFile(`ppt/notesSlides/${name}`, Buffer.from(xml));
    for (const [n, xml] of Object.entries(rels)) zip.addFile(`ppt/slides/_rels/slide${n}.xml.rels`, Buffer.from(xml));
    return zip.toBuffer();
  }

  it('pairs notes through the slide rels even when the notes part number differs from the slide number', () => {
    const res = extractPptx(
      pptxWithRels(
        { 1: slideXml(['First']), 2: slideXml(['Second']) },
        { 'notesSlide7.xml': slideXml(['note for slide two']) },
        {
          1: `<?xml version="1.0"?><Relationships ${RELS_NS}></Relationships>`,
          2:
            `<?xml version="1.0"?><Relationships ${RELS_NS}>` +
            `<Relationship Id="rId9" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide7.xml"/>` +
            '</Relationships>',
        },
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual([
      '[slide 1]',
      'First',
      '[slide 2]',
      'Second',
      '[slide 2 notes]',
      'note for slide two',
    ]);
  });

  it('accepts single-quoted rels attributes and whitespace around =', () => {
    const res = extractPptx(
      pptxWithRels(
        { 1: slideXml(['Solo']) },
        { 'notesSlide3.xml': slideXml(['quoted note']) },
        {
          1:
            `<?xml version="1.0"?><Relationships ${RELS_NS}>` +
            `<Relationship Id='r1' Type = '${NOTES_TYPE}' Target = '../notesSlides/notesSlide3.xml'/>` +
            '</Relationships>',
        },
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('[slide 1]\nSolo\n[slide 1 notes]\nquoted note');
  });

  it('with a rels part that names NO notes slide, the numeric twin is NOT attached', () => {
    const res = extractPptx(
      pptxWithRels(
        { 1: slideXml(['No notes really']) },
        { 'notesSlide1.xml': slideXml(['orphan notes part']) },
        { 1: `<?xml version="1.0"?><Relationships ${RELS_NS}></Relationships>` },
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('[slide 1]\nNo notes really');
  });

  it('falls back to numeric pairing when the slide has no rels part', () => {
    const res = extractPptx(
      pptxBytes({ 1: slideXml(['Fallback slide']) }, { 1: slideXml(['numeric note']) }),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('[slide 1]\nFallback slide\n[slide 1 notes]\nnumeric note');
  });
});

// ── ODF namespace-prefix normalization + attribute quoting ─────────────────

describe('ODF prefix normalization and attribute robustness', () => {
  it('extracts an odt whose producer bound NON-conventional prefixes to the ODF namespaces', () => {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/vnd.oasis.opendocument.text'));
    zip.addFile(
      'content.xml',
      Buffer.from(
        '<?xml version="1.0"?><o:document-content ' +
          'xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
          "xmlns:t='urn:oasis:names:tc:opendocument:xmlns:text:1.0'>" +
          '<o:body><o:text>' +
          '<t:h>Title</t:h>' +
          "<t:p>a<t:tab/>b<t:line-break/>c<t:s t:c = '3'/>d</t:p>" +
          '</o:text></o:body></o:document-content>',
      ),
    );
    const res = extractOdt(zip.toBuffer());
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['Title', 'a\tb', 'c   d']);
  });

  it('extracts an odp whose draw/presentation prefixes are non-conventional', () => {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/vnd.oasis.opendocument.presentation'));
    zip.addFile(
      'content.xml',
      Buffer.from(
        '<?xml version="1.0"?><office:document-content ' +
          'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
          'xmlns:txt="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
          'xmlns:d="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
          'xmlns:pres="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0">' +
          '<office:body><office:presentation>' +
          '<d:page><d:frame><txt:p>Visible</txt:p></d:frame>' +
          '<pres:notes><txt:p>a note</txt:p></pres:notes></d:page>' +
          '</office:presentation></office:body></office:document-content>',
      ),
    );
    const res = extractOdp(zip.toBuffer());
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[slide 1]', 'Visible', '[slide 1 notes]', 'a note']);
  });

  it('reads single-quoted table:name and repeat attributes in an ods', () => {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/vnd.oasis.opendocument.spreadsheet'));
    zip.addFile(
      'content.xml',
      Buffer.from(
        '<?xml version="1.0"?><office:document-content ' +
          'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
          'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
          'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">' +
          '<office:body><office:spreadsheet>' +
          "<table:table table:name = 'Quoted'><table:table-row>" +
          "<table:table-cell table:number-columns-repeated = '3'><text:p>x</text:p></table:table-cell>" +
          '<table:table-cell><text:p>end</text:p></table:table-cell>' +
          '</table:table-row></table:table>' +
          '</office:spreadsheet></office:body></office:document-content>',
      ),
    );
    const res = extractOds(zip.toBuffer());
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[sheet: Quoted]', 'x\tx\tx\tend']);
  });
});

// ── odp self-closing pages / ods in-cell breaks ────────────────────────────

describe('ODF edge shapes', () => {
  it('a self-closing <draw:page/> is an EMPTY slide, not a dropped one', () => {
    const res = extractOdp(
      odfBytes(
        'application/vnd.oasis.opendocument.presentation',
        '<office:presentation>' +
          odpPage(['First real slide']) +
          '<draw:page draw:name="blank"/>' +
          odpPage(['Third slide']) +
          '</office:presentation>',
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[slide 1]', 'First real slide', '[slide 2]', '[slide 3]', 'Third slide']);
    expect(res.summary).toContain('3 slides');
  });

  it('a deck of ONLY self-closing pages still parses as its (blank) slides', () => {
    const res = extractOdp(
      odfBytes('application/vnd.oasis.opendocument.presentation', '<office:presentation><draw:page/><draw:page/></office:presentation>'),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('[slide 1]\n[slide 2]');
  });

  it('element-produced newlines/tabs INSIDE an ods cell become single spaces — the TSV row survives', () => {
    const res = extractOds(
      odsBytes(
        '<table:table table:name="Wrapped"><table:table-row>' +
          '<table:table-cell><text:p>line one<text:line-break/>line two<text:tab/>tabbed</text:p></table:table-cell>' +
          '<table:table-cell><text:p>next cell</text:p></table:table-cell>' +
          '</table:table-row></table:table>',
      ),
    );
    if (!res.ok) throw new Error(res.message);
    const lines = res.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('line one line two tabbed\tnext cell');
  });
});

// ── decompression bounds (zip bombs) ───────────────────────────────────────

describe('bounded extraction (zip bombs / oversized inputs)', () => {
  const PART_LIMIT = 50 * 1024 * 1024;
  // Compresses to a few KB, inflates past the 50 MB part limit.
  const bigXml = (): Buffer => Buffer.alloc(PART_LIMIT + 1024, 0x20);

  it('refuses a docx whose word/document.xml declares an over-limit uncompressed size', () => {
    const zip = new AdmZip();
    zip.addFile('word/document.xml', bigXml());
    const res = extractDocx(zip.toBuffer());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('extraction limit');
    expect(res.message).toContain('word/document.xml');
  });

  it('refuses an odt whose content.xml declares an over-limit uncompressed size', () => {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/vnd.oasis.opendocument.text'));
    zip.addFile('content.xml', bigXml());
    const res = extractOdt(zip.toBuffer());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('extraction limit');
  });

  it('refuses a pptx with an over-limit slide part', () => {
    const zip = new AdmZip();
    zip.addFile('ppt/slides/slide1.xml', bigXml());
    const res = extractPptx(zip.toBuffer());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('extraction limit');
  });

  it('refuses an xlsx with an over-limit part BEFORE SheetJS inflates it', () => {
    const zip = new AdmZip();
    zip.addFile('xl/worksheets/sheet1.xml', bigXml());
    const res = extractXlsx(zip.toBuffer());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('extraction limit');
  });

  it('refuses a PDF larger than the 50 MB byte cap without parsing it', async () => {
    const big = Buffer.alloc(PART_LIMIT + 1, 0x25);
    const res = await extractPdf(big);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('extraction limit');
  });
});

// ── single-pass prefix normalization + alias bound ─────────────────────────

describe('markup that only LOOKS like metadata', () => {
  it('a <Relationship> written inside a comment does not point the notes lookup', async () => {
    // A decoy in a comment used to answer as live metadata, so the notes for a
    // slide came from whichever part its author named.
    const bytes = pptxBytes(
      { 1: slideXml(['Real slide']) },
      { 2: slideXml(['the decoy notes']), 7: slideXml(['the real notes']) },
      {
        'ppt/slides/_rels/slide1.xml.rels':
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<!-- <Relationship Id="rX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/> -->' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide7.xml"/>' +
          '</Relationships>',
      },
    );
    const res = await extractPptx(bytes);
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toContain('the real notes');
    expect(res.text).not.toContain('the decoy notes');
  });

  it('a commented <w:body> does not answer as the document body', () => {
    const res = extractDocx(docxBytes('<!-- <w:body>' + para('ghost') + '</w:body> -->' + para('real')));
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('real');
  });
});
describe('ODF namespace prefixes are the document’s own choice', () => {
  // These used to be answered by rewriting every non-conventional prefix across
  // content.xml before scanning it — a pass that had to be bounded against
  // crafted alias lists and could still corrupt paragraph text that happened to
  // look like an alias. Elements are matched on their LOCAL name now, so the
  // prefix simply does not matter and the pass is gone.
  const odtWith = (rootAttrs: string, body: string): Buffer =>
    odfBytesRaw('application/vnd.oasis.opendocument.text', rootAttrs, body);

  it('extracts a document that binds the ODF namespaces to UNUSUAL prefixes', () => {
    const res = extractOdt(
      odtWith(
        'xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:zz="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
        '<o:body><o:text><zz:p>Renamed prefixes</zz:p><zz:h>And a heading</zz:h></o:text></o:body>',
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Renamed prefixes\nAnd a heading');
  });

  it('extracts a document that DEFAULTS the text namespace and uses no prefix at all', () => {
    const res = extractOdt(
      odtWith(
        'xmlns="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
        '<body><text><p>No prefix anywhere</p></text></body>',
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('No prefix anywhere');
  });

  it('leaves paragraph text that merely LOOKS like a prefix alone', () => {
    const res = extractOdt(
      odtWith(
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
        '<office:body><office:text><text:p>see t: and zz: in the prose</text:p></office:text></office:body>',
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('see t: and zz: in the prose');
  });
});

// ── attribute tokenizer (quoted-value skipping) ────────────────────────────

describe('xmlAttrValue tokenizer', () => {
  it('never matches an attribute-looking sequence INSIDE another attribute quoted value', () => {
    expect(xmlAttrValue(`<a foo="Target='evil'" Target="real"/>`, 'Target')).toBe('real');
    expect(xmlAttrValue(`<a foo="Target='evil'"/>`, 'Target')).toBeUndefined();
    expect(xmlAttrValue(`<a foo='Target="evil"' Target='real'/>`, 'Target')).toBe('real');
  });

  it('accepts both quote styles and whitespace around =', () => {
    expect(xmlAttrValue(`<t:s t:c = '3'/>`, 't:c')).toBe('3');
    expect(xmlAttrValue('<t:s t:c="4"/>', 't:c')).toBe('4');
  });

  it('matches the full (prefixed) name exactly, and scans attrs-only fragments', () => {
    expect(xmlAttrValue('<x a:n="p" n="bare"/>', 'n')).toBe('bare');
    expect(xmlAttrValue(' table:number-columns-repeated="7"', 'table:number-columns-repeated')).toBe('7');
  });

  it('xmlAttrValueByLocalName matches through any namespace prefix', () => {
    expect(xmlAttrValueByLocalName('<r:Relationship r:Target="notes.xml"/>', 'Target')).toBe('notes.xml');
    expect(xmlAttrValueByLocalName('<Relationship Target="notes.xml"/>', 'Target')).toBe('notes.xml');
    expect(xmlAttrValueByLocalName(`<r:Rel foo="Target='no'" r:Target='yes'/>`, 'Target')).toBe('yes');
  });

  it('xmlAttrValueByLocalName never mistakes an xmlns declaration for the attribute', () => {
    // `xmlns:Target` binds a namespace prefix named "Target" — it is a
    // declaration, not a Target attribute, and its value is a URI.
    expect(
      xmlAttrValueByLocalName('<Relationship xmlns:Target="http://ns.example/x" Target="real.xml"/>', 'Target'),
    ).toBe('real.xml');
    expect(xmlAttrValueByLocalName('<Relationship xmlns:Type="http://ns.example/x"/>', 'Type')).toBeUndefined();
    expect(xmlAttrValueByLocalName('<Relationship xmlns="http://ns.example/x"/>', 'xmlns')).toBeUndefined();
  });

  it('stops safely on a malformed tail (unterminated quote, unquoted value)', () => {
    expect(xmlAttrValue('<a b="ok" c="unterminated', 'b')).toBe('ok');
    expect(xmlAttrValue('<a b=unquoted c="x"/>', 'c')).toBeUndefined();
  });
});

// ── crafted ODF: unmatched openers must not rescan the document ────────────

describe('ODF element scanning stays linear on crafted content.xml', () => {
  /**
   * The shape that used to pin the extractor: a wall of OPENERS whose close
   * tag never comes. Each one made the old
   * `<text:p…(?:\/>|>([\s\S]*?)<\/text:p>)` regex re-scan everything to the
   * right, so cost grew as openers x bytes — 464 KB measured at 2.3 s and
   * QUADRUPLING per doubling, i.e. hours at the 50 MB `MAX_DOC_PART_BYTES`
   * cap, from an upload that zips down to a few kilobytes.
   *
   * The bound is deliberately generous (seconds): it is here to catch a
   * return of the quadratic, not to police CI's scheduler. The scanner does
   * these in single-digit milliseconds; the old regex needed ~30 s.
   */
  const GENEROUS_MS = 5_000;

  it('an odt of 40k unmatched <text:p> openers extracts its real paragraph, fast', () => {
    const bytes = odtBytes('<text:p>Kept</text:p>' + '<text:p text:style-name="s">x'.repeat(40_000));
    const t0 = performance.now();
    const res = extractOdt(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    // The real paragraph comes first and is intact. CHANGED: the openers nest
    // rather than being dropped, so the `x` between them is recovered as one
    // more paragraph — bounded by MAX_ELEMENT_DEPTH, and it IS text the file
    // contains. What matters here is that this stays fast and bounded.
    expect(res.text.startsWith('Kept\n')).toBe(true);
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('an odp of 40k unmatched <draw:page> openers keeps its real slide, fast', () => {
    const bytes = odfBytes(
      'application/vnd.oasis.opendocument.presentation',
      '<office:presentation>' +
        odpPage(['Real slide']) +
        '<draw:page draw:name="a">'.repeat(40_000) +
        '</office:presentation>',
    );
    const t0 = performance.now();
    const res = extractOdp(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    // CHANGED: the dangling openers nest into one recovered (empty) page
    // instead of being dropped. The real slide is intact and first.
    expect(res.text.startsWith('[slide 1]\nReal slide')).toBe(true);
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('an ods of 20k unmatched row/cell openers keeps its real row, fast', () => {
    const bytes = odsBytes(
      '<table:table table:name="Q">' +
        `<table:table-row>${odsCell('alive')}</table:table-row>` +
        '<table:table-row><table:table-cell>'.repeat(20_000) +
        '</table:table>',
    );
    const t0 = performance.now();
    const res = extractOds(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[sheet: Q]', 'alive']);
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('an UNTERMINATED attribute quote ends the scan instead of restarting it per opener', () => {
    // The other half of the old blow-up: the lazy attribute region could never
    // pass an unclosed quote, so every opener paid a full scan to find that out.
    const bytes = odtBytes(
      '<text:p>Kept</text:p>' + '<text:p text:style-name="never closed'.repeat(40_000),
    );
    const t0 = performance.now();
    const res = extractOdt(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Kept');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('an odt wall of openers ending at a FAR close tag stays linear too', () => {
    // The residual hole in the round-4/5 ODF scanner, closed by sharing
    // `xmlElementBlocks` with the OOXML walks: a failure-only memo recorded
    // nothing when every attribute scan succeeded at a far-away `>`. Measured
    // on this exact shape before the fix: 740 KB took 44.6 s.
    const bytes = odtBytes(
      '<text:p>Kept</text:p>' + '<text:p text:style-name="never closed'.repeat(20_000),
    );
    const t0 = performance.now();
    const res = extractOdt(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Kept');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('reads a self-closing paragraph, a quoted /> and a quoted > the way the regex did', () => {
    const text = (bodyXml: string): string => {
      const res = extractOdt(odtBytes(bodyXml));
      if (!res.ok) throw new Error(res.message);
      return res.text;
    };
    // A self-closing paragraph is an EMPTY line, with attributes or without.
    expect(text('<text:p>a</text:p><text:p/><text:p text:style-name="s"/><text:p>b</text:p>')).toBe(
      'a\n\n\nb',
    );
    // A `/>` or a `>` inside a quoted attribute value is part of the value.
    expect(text('<text:p n="a/>b">body</text:p>')).toBe('body');
    expect(text("<text:p n='a>b'>body</text:p>")).toBe('body');
    // A heading and a paragraph interleave in document order; `<text:page-number>`
    // is not a paragraph.
    expect(text('<text:h>H</text:h><text:page-number>9</text:page-number><text:p>P</text:p>')).toBe(
      'H\nP',
    );
    // CHANGED: an opener with no close tag anywhere used to contribute nothing.
    // The parser closes it at end of input, so its text is recovered.
    expect(text('<text:p>dangling')).toBe('dangling');
  });
});

// ── numeric character references ───────────────────────────────────────────

describe('decodeXmlEntities — numeric character references', () => {
  it('decodes well-formed decimal and hex references', () => {
    expect(decodeXmlEntities('&#65;&#x41;&#x1F600;')).toBe('AA\u{1F600}');
    expect(decodeXmlEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
  });

  it('leaves a MALFORMED reference literal instead of inventing a character', () => {
    // `&#12A;` is not a reference at all. The old pattern accepted hex digits
    // after a bare `#`, then parsed them as DECIMAL — parseInt('12A', 10)
    // stops at the 'A' and yields 12, so the text silently became U+000C.
    expect(decodeXmlEntities('&#12A;')).toBe('&#12A;');
    expect(decodeXmlEntities('price &#12A; each')).toBe('price &#12A; each');
    expect(decodeXmlEntities('&#;')).toBe('&#;');
    expect(decodeXmlEntities('&#xZZ;')).toBe('&#xZZ;');
  });

  it('follows XML, not HTML, on the hex marker: `&#X41;` is not a reference', () => {
    // XML 1.0 §4.1 spells the marker lowercase `x` only; HTML5 also accepts
    // `X`. This decoder serves XML parts (and an email body strip that leans
    // on it), so the strict reading wins and a capital X stays literal rather
    // than being read as an unrelated decimal.
    expect(decodeXmlEntities('&#X41;')).toBe('&#X41;');
  });

  it('leaves an out-of-range code point literal rather than throwing', () => {
    expect(decodeXmlEntities('&#1114112;')).toBe('&#1114112;'); // 0x110000
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;');
  });
});

// ── duplicate numeric slide parts ──────────────────────────────────────────

describe('extractPptx — two part names parsing to the SAME slide number', () => {
  it('keeps ONE slide per number, choosing the first in ascending part-name order', () => {
    // A producer can ship both `slide1.xml` and `slide01.xml`. Zip entry order
    // is not a contract, so the winner is picked by part NAME — the same rule
    // the browser twin (`pptxOutline.ts`) applies, so the viewer and an
    // agent's `read_file` describe the same deck.
    const zip = new AdmZip();
    zip.addFile('ppt/slides/slide1.xml', Buffer.from(slideXml(['canonical one'])));
    zip.addFile('ppt/slides/slide01.xml', Buffer.from(slideXml(['zero-padded twin'])));
    zip.addFile('ppt/slides/slide2.xml', Buffer.from(slideXml(['two'])));
    const res = extractPptx(zip.toBuffer());
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[slide 1]', 'zero-padded twin', '[slide 2]', 'two']);
    expect(res.summary).toContain('2 slides');
  });

  const NOTES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
  const relsXml = (target: string): string =>
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${NOTES_REL}" Target="${target}"/></Relationships>`;

  it('follows the SELECTED part name to the rels — a zero-padded winner keeps its own notes', () => {
    // The regression the dedup introduced: the winner is chosen by NAME, but
    // the notes lookup rebuilt the rels path from the NUMBER. With
    // `slide01.xml` winning, `ppt/slides/_rels/slide1.xml.rels` is the LOSING
    // part's relationships — so slide 1 either lost its notes or was handed
    // the other file's.
    const zip = new AdmZip();
    zip.addFile('ppt/slides/slide1.xml', Buffer.from(slideXml(['canonical one'])));
    zip.addFile('ppt/slides/slide01.xml', Buffer.from(slideXml(['zero-padded twin'])));
    zip.addFile('ppt/slides/_rels/slide01.xml.rels', Buffer.from(relsXml('../notesSlides/notesSlide01.xml')));
    zip.addFile('ppt/notesSlides/notesSlide01.xml', Buffer.from(slideXml(['the padded twin speaks'])));
    zip.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from(relsXml('../notesSlides/notesSlide1.xml')));
    zip.addFile('ppt/notesSlides/notesSlide1.xml', Buffer.from(slideXml(['notes of the part that LOST'])));
    const res = extractPptx(zip.toBuffer());
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual([
      '[slide 1]',
      'zero-padded twin',
      '[slide 1 notes]',
      'the padded twin speaks',
    ]);
  });

  it('and the no-rels fallback mirrors the name too — slide01.xml pairs with notesSlide01.xml', () => {
    const zip = new AdmZip();
    zip.addFile('ppt/slides/slide01.xml', Buffer.from(slideXml(['only slide'])));
    zip.addFile('ppt/notesSlides/notesSlide01.xml', Buffer.from(slideXml(['padded notes'])));
    const res = extractPptx(zip.toBuffer());
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[slide 1]', 'only slide', '[slide 1 notes]', 'padded notes']);
  });
});

// ── rels parsing: namespace-prefixed Relationship elements ─────────────────

describe('notesTargetFromRels — prefixed rels', () => {
  const NOTES_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';

  it('finds the notes Target on a namespace-prefixed <r:Relationship>', () => {
    const rels =
      '<?xml version="1.0"?><r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<r:Relationship r:Id="rId2" r:Type="${NOTES_TYPE}" r:Target="../notesSlides/notesSlide9.xml"/>` +
      '</r:Relationships>';
    expect(notesTargetFromRels(rels)).toBe('../notesSlides/notesSlide9.xml');
  });

  it('accepts a NON-ASCII namespace prefix (full XML NCName) — an ASCII-only \\w match dropped these', () => {
    const rels =
      '<?xml version="1.0"?><sé:Relationships xmlns:sé="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<sé:Relationship sé:Id="rId2" sé:Type="${NOTES_TYPE}" sé:Target="../notesSlides/notesSlide5.xml"/>` +
      '</sé:Relationships>';
    expect(notesTargetFromRels(rels)).toBe('../notesSlides/notesSlide5.xml');
  });

  it('ignores xmlns:Type / xmlns:Target declarations on the Relationship element itself', () => {
    const rels =
      '<?xml version="1.0"?><Relationships>' +
      `<Relationship xmlns:Target="http://ns.example/decl" Id="r1" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide2.xml"/>` +
      '</Relationships>';
    expect(notesTargetFromRels(rels)).toBe('../notesSlides/notesSlide2.xml');
  });

  it('end-to-end: a pptx whose rels use a prefixed Relationship still pairs its notes', () => {
    const zip = new AdmZip();
    zip.addFile(
      '[Content_Types].xml',
      Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    );
    zip.addFile('ppt/slides/slide1.xml', Buffer.from(slideXml(['Deck'])));
    zip.addFile('ppt/notesSlides/notesSlide4.xml', Buffer.from(slideXml(['prefixed note'])));
    zip.addFile(
      'ppt/slides/_rels/slide1.xml.rels',
      Buffer.from(
        '<?xml version="1.0"?><r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships">' +
          `<r:Relationship r:Id="rId2" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide4.xml"/>` +
          '</r:Relationships>',
      ),
    );
    const res = extractPptx(zip.toBuffer());
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('[slide 1]\nDeck\n[slide 1 notes]\nprefixed note');
  });
});

// ── quote-aware block delimiters (`/>` inside attribute values) ────────────

describe('ODF block regexes are quote-aware about /> inside attribute values', () => {
  it('a draw:page whose attribute value contains /> keeps its body', () => {
    const res = extractOdp(
      odfBytes(
        'application/vnd.oasis.opendocument.presentation',
        '<office:presentation>' +
          '<draw:page draw:name="a/>b" other="x/>y"><draw:frame><text:p>Survived</text:p></draw:frame></draw:page>' +
          '</office:presentation>',
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('[slide 1]\nSurvived');
  });

  it('a text:p whose attribute value contains /> keeps its body (odt)', () => {
    const res = extractOdt(odtBytes('<text:p text:style-name="s/>t">Kept</text:p>'));
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Kept');
  });

  it('ods rows and cells with /> inside attribute values keep their content', () => {
    const res = extractOds(
      odsBytes(
        '<table:table table:name="Q"><table:table-row table:style-name="r/>x">' +
          '<table:table-cell table:style-name="c/>y"><text:p>alive</text:p></table:table-cell>' +
          '<table:table-cell><text:p>next</text:p></table:table-cell>' +
          '</table:table-row></table:table>',
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[sheet: Q]', 'alive\tnext']);
  });

  it('self-closing elements WITH attributes still hit the /> branch after the rewrite', () => {
    const res = extractOds(
      odsBytes(
        '<table:table table:name="S"><table:table-row>' +
          '<table:table-cell table:number-columns-repeated="2"/>' +
          '<table:table-cell><text:p>end</text:p></table:table-cell>' +
          '</table:table-row></table:table>',
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[sheet: S]', '\t\tend']);
  });
});

// ── docx/pptx: the OOXML scanner ───────────────────────────────────────────

describe('ooxml-text — the docx/pptx walks are linear and quote-aware', () => {
  /**
   * The same shape that pinned the ODF extractors, in the OOXML twins that
   * were deliberately left standing last round. `<w:p(?:\s[^>]*)?>([\s\S]*?)
   * </w:p>` re-scanned everything to the right from EVERY opener whose close
   * tag never came, so cost grew as openers x bytes. Measured before the
   * rewrite: 80k openers (391 KB) took 19.4 s, QUADRUPLING per doubling —
   * days of pinned CPU at the 50 MB `MAX_DOC_PART_BYTES` cap, from a
   * .docx/.pptx that zips down to a few kilobytes. `word/document.xml` and
   * `ppt/slides/slideN.xml` are user-uploaded bytes, so anyone who can add a
   * file to a knowledge base could reach it.
   *
   * Generous by design (seconds): here to catch a RETURN of the quadratic,
   * not to police CI's scheduler. The scanner does these in single-digit ms.
   */
  const GENEROUS_MS = 5_000;

  it('a docx of 80k unmatched <w:p> openers extracts its real paragraph, fast', () => {
    const bytes = docxBytes('<w:p><w:r><w:t>Kept</w:t></w:r></w:p>' + '<w:p>'.repeat(80_000));
    const t0 = performance.now();
    const res = extractDocx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Kept');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('a pptx of 80k unmatched <a:p> openers still reads its real slide text, fast', () => {
    const bytes = pptxBytes({
      1: `<p:sld ${A_NS}><a:p><a:r><a:t>Alive</a:t></a:r></a:p>${'<a:p algn="ctr">'.repeat(80_000)}</p:sld>`,
    });
    const t0 = performance.now();
    const res = extractPptx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[slide 1]', 'Alive']);
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('40k unmatched <w:t> RUN openers inside one paragraph stay linear too', () => {
    // paragraphRunText carried the identical pattern, one level down.
    const bytes = docxBytes(
      `<w:p><w:r><w:t>Kept</w:t></w:r>${'<w:t xml:space="preserve">'.repeat(40_000)}</w:p>`,
    );
    const t0 = performance.now();
    const res = extractDocx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Kept');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('an UNTERMINATED attribute quote ends the scan instead of restarting it per opener', () => {
    // The second failure mode: quote-awareness means an unclosed quote runs to
    // the end of the part, so without the dead-opener memo every opener would
    // pay a full scan to discover that. Measured at 40k openers before the
    // memo existed in this walk: 85 s.
    const bytes = docxBytes(
      '<w:p><w:r><w:t>Kept</w:t></w:r></w:p>' + '<w:p w:rsidR="never closed'.repeat(40_000),
    );
    const t0 = performance.now();
    const res = extractDocx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Kept');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('a wall of openers whose attribute scan ends at a FAR close tag stays linear', () => {
    // The shape a failure-only memo misses. Here every opener's attribute scan
    // reaches the `>` of the `</w:body>` past the wall, so every scan SUCCEEDS
    // — nothing is recorded as dead — and each one is then rejected by the
    // `lastIndexOf` guard, at the cost of a full traversal apiece. Measured on
    // the ODF twin, which shipped with exactly this hole: 740 KB took 44.6 s
    // and quadrupled per doubling. The memo now records successes too.
    const bytes = docxBytes(
      '<w:p><w:r><w:t>Kept</w:t></w:r></w:p>' + '<w:p w:rsidR="never closed'.repeat(20_000),
    );
    const t0 = performance.now();
    const res = extractDocx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Kept');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('CHANGED: a self-closing <w:p/> is an EMPTY paragraph, not a dropped one', () => {
    // Before the rewrite the pattern admitted no `/>` branch, so `<w:p/>`
    // matched nothing and vanished from the output entirely — an empty line
    // the author wrote simply disappeared. It now reads as the empty
    // paragraph it is, which is what `<w:p></w:p>` has always produced and
    // what the ODF scanner does for `<text:p/>`.
    const res = extractDocx(
      docxBytes('<w:p><w:r><w:t>A</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>B</w:t></w:r></w:p>'),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['A', '', 'B']);
    expect(res.summary).toContain('3 paragraphs');
  });

  it('CHANGED: a self-closing <w:p/> WITH attributes is an empty paragraph too', () => {
    const res = extractDocx(
      docxBytes('<w:p w:rsidR="00A1"/><w:p><w:r><w:t>B</w:t></w:r></w:p>'),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['', 'B']);
  });

  it('CHANGED: a self-closing <w:tc/> is an EMPTY table cell, not a dropped column', () => {
    const res = extractDocx(
      docxBytes(
        '<w:tbl><w:tr><w:tc/><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      ),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['\tb']);
  });

  it('CHANGED: a `>` inside a quoted attribute no longer leaks into the text', () => {
    // `[^>]*` stopped at the FIRST `>`, even inside a quoted value, so the tag
    // was truncated: the block boundary landed mid-attribute and the attribute
    // tail was emitted as document text. This paragraph used to extract as
    // ` b">Hi` — the run property's value and a stray quote in the body.
    const res = extractDocx(
      docxBytes('<w:p><w:r><w:t w:val="a &gt; b" w:x="a > b">Hi</w:t></w:r></w:p>'),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Hi');
  });

  it('CHANGED: a quoted `>` on the PARAGRAPH tag keeps the block boundary right', () => {
    const res = extractDocx(
      docxBytes('<w:p w:rsidR="a > b"><w:r><w:t>Hi</w:t></w:r></w:p>'),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Hi');
  });

  it('a pptx paragraph with a quoted `>` and a self-closing empty one read correctly', () => {
    // pptx DROPS blank paragraphs (a deck's outline is its non-empty lines),
    // so `<a:p/>` stays invisible there — but the quoted `>` used to prepend
    // `q">` to the slide's text.
    const res = extractPptx(
      pptxBytes({
        1: `<p:sld ${A_NS}><a:p/><a:p><a:r><a:t x="p>q">Hi</a:t></a:r></a:p></p:sld>`,
      }),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text.split('\n')).toEqual(['[slide 1]', 'Hi']);
  });

  it('still refuses to read <w:pPr> as a <w:p>, and RECOVERS a dangling opener', () => {
    // A longer name that merely STARTS with the wanted one is still not a
    // match. CHANGED with the parser: an element left open at end of input is
    // closed implicitly, so `<w:p>dangling` is a paragraph holding its text
    // rather than an opener dropped on the floor. Recovering the characters a
    // truncated document does contain beats discarding them.
    const res = extractDocx(
      docxBytes('<w:pPr><w:r><w:t>props</w:t></w:r></w:pPr><w:p><w:r><w:t>real</w:t></w:r></w:p><w:p>dangling'),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('real');
    expect(res.summary).toContain('2 paragraphs');
  });

  it('CHANGED: a malformed `<w:t/x>` is read the way a parser reads it', () => {
    // The hand-rolled scanner ruled that `/` ends a name only as the `/` of a
    // `/>`, so `<w:t/x>` named nothing and its content was withheld.
    // htmlparser2 recovers instead — `<w:t x>` — and the text inside comes
    // out. Neither is "wrong" for markup this broken, and recovery is the
    // behaviour of the parser the rest of the world reads these files with.
    const res = extractDocx(docxBytes('<w:p><w:r><w:t/x>leaked</w:t><w:t>kept</w:t></w:r></w:p>'));
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('leakedkept');
  });

  it('an attribute quote that never closes still costs two traversals, not one per opener', () => {
    // Cubic's round-5 note on the (now deleted) ODF scanner: a `<` met INSIDE
    // an unterminated quote is recorded by nobody, so — the worry went — every
    // opener behind it rescans the document. It does not. The FIRST scan that
    // begins OUTSIDE the quote walks that same tail in the no-quote state and
    // records every one of them, so the wall costs two traversals in total.
    // Measured on the shared scanner at 3.2 M openers (15.6 MB): 1.78 s,
    // growing ~2.6x per doubling — linear plus the memo's own GC cost, not the
    // 4x a quadratic gives. With the memo bounded (see MAX_TAG_MEMO): 61 ms.
    const bytes = docxBytes(
      '<w:p><w:r><w:t>Kept</w:t></w:r></w:p><w:p w:rsidR="' + '<w:p '.repeat(40_000),
    );
    const t0 = performance.now();
    const res = extractDocx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('Kept');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('a wall of unterminated openers is bounded, and the real paragraphs survive', () => {
    // 300 k openers that never close. The hand-rolled scanner needed a tag-end
    // memo to stay linear here, then a cap on the memo because it reached
    // 1170 MB on a 50 MB part, and the cap then had to abandon the tail. The
    // parser needs none of it: the wall is one unterminated tag, and the
    // paragraphs on either side of it both come out.
    const bytes = docxBytes(para('first') + '<w:p '.repeat(300_000) + para('last'));
    const t0 = performance.now();
    const res = extractDocx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('first\nlast');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('a commented-out paragraph is not extracted, however big the comment', () => {
    // A comment is WELL-FORMED xml and may say anything, `<w:p>` included.
    // Reading its insides as markup extracted a commented paragraph as if it
    // were document text — and, in the scanner this replaced, charged every
    // `<` in it to a memo whose cap then dropped everything after the comment.
    const small = extractDocx(docxBytes(`<!-- ${para('ghost')} -->${para('real')}`));
    if (!small.ok) throw new Error(small.message);
    expect(small.text).toBe('real');

    const bytes = docxBytes(`<!-- ${'<w:p '.repeat(300_000)} -->${para('survives')}`);
    const t0 = performance.now();
    const res = extractDocx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('survives');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('a `</w:p>` inside a comment or CDATA does not end the paragraph holding it', () => {
    const commented = extractDocx(
      docxBytes('<w:p><w:r><w:t>a</w:t></w:r><!-- </w:p> --><w:r><w:t>b</w:t></w:r></w:p>'),
    );
    if (!commented.ok) throw new Error(commented.message);
    expect(commented.text).toBe('ab');
    expect(commented.summary).toContain('1 paragraph');

    const cdata = extractDocx(
      docxBytes('<w:p><w:r><w:t>a</w:t></w:r><![CDATA[</w:p>]]><w:r><w:t>b</w:t></w:r></w:p>'),
    );
    if (!cdata.ok) throw new Error(cdata.message);
    expect(cdata.text).toBe('ab');
  });

  it('CDATA and processing instructions are text, not markup', () => {
    const res = extractDocx(
      docxBytes(`<![CDATA[${para('ghost')}]]><?xml-stylesheet href="x"?>${para('real')}`),
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('real');
    expect(res.summary).toContain('1 paragraph');
  });

  it('stays fast on an ORDINARY document — 60k plain paragraphs', () => {
    // Worth keeping through the rewrite: an earlier attempt at the comment rule
    // asked "does a section start before this close tag?" with a scan per
    // element, which on a document containing no comments at all — nearly every
    // real document — made ordinary extraction quadratic.
    const bytes = docxBytes(para('x').repeat(60_000));
    const t0 = performance.now();
    const res = extractDocx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.summary).toContain('60000 paragraphs');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('reads a document full of comments without an index to blow up on', () => {
    // `<!---->` is seven bytes, so a 50 MB part spells seven million valid
    // comments. Indexing their spans to answer "is this close tag commented
    // out?" allocated per comment and had to be capped, which gave up on parts
    // that were merely comment-heavy. The parser tracks no such thing.
    const bytes = docxBytes(para('first') + '<!---->'.repeat(200_000) + para('last'));
    const t0 = performance.now();
    const res = extractDocx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(res.text).toBe('first\nlast');
    expect(ms).toBeLessThan(GENEROUS_MS);
  });

  it('stays bounded when 50k paragraph openers nest without ever closing', () => {
    // Every close tag here sits inside a comment, so none of them closes
    // anything and the openers nest 50 k deep. The nesting is what costs: the
    // parser holds a stack entry per open element and its own cost climbs past
    // linear on an enormous one, so MAX_ELEMENT_DEPTH stops the parse — with
    // the text reached so far kept rather than discarded.
    const bytes = docxBytes('<w:p>'.repeat(50_000) + '<!-- </w:p> -->'.repeat(2_000));
    const t0 = performance.now();
    const res = extractDocx(bytes);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(res.message);
    expect(ms).toBeLessThan(GENEROUS_MS);
  });
});
