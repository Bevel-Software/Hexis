import type { ExtractResult } from './doc-extract.types.js';
import { MAX_DOC_PART_BYTES } from './ooxml-text.js';

/**
 * Extract a PDF's TEXT LAYER page by page with pdf.js (`pdfjs-dist`,
 * Mozilla's maintained renderer — chosen over the unmaintained thin wrappers
 * around it). The LEGACY build is the one supported under Node; it is loaded
 * lazily (and once) because it is a heavyweight module most deployments only
 * need after the first PDF read.
 *
 * Layout heuristic: text items on one line are joined with single spaces; a
 * new line starts when pdf.js flags an EOL or the item's Y position jumps.
 * A PDF with NO text layer (a scan) extracts to just the `[page N]` markers,
 * and the summary says "no text layer (scanned document?)" — no OCR in v1.
 */
/**
 * How much DECODED text one PDF may yield before extraction gives up.
 *
 * The raw-size cap below bounds what arrives; it does not bound what comes
 * out. PDF text lives in compressed streams, so a file comfortably under
 * 50 MB can decode to far more than that, and every character of it is held
 * in `lines` until the extraction returns. This bound is the decoded
 * counterpart, checked as the text accumulates rather than after.
 */
const MAX_PDF_TEXT_CHARS = 20 * 1024 * 1024; // 20M chars of extracted text

/**
 * How many pages one PDF may have before extraction gives up.
 *
 * The decoded-text bound does not cover a document whose cost is its PAGE
 * COUNT rather than its prose: every page costs a `getPage`, a
 * `getTextContent` and a retained `[page N]` marker even when it holds no
 * text at all, so a file declaring hundreds of thousands of empty pages spends
 * minutes and megabytes without ever tripping a character budget. Real
 * documents do not come close — a 2,000-page manual is an outlier.
 */
const MAX_PDF_PAGES = 10_000;

/**
 * How many text items one PAGE may hold. `getTextContent` has no streaming
 * form: it returns the entire page's items at once, so the per-character
 * budget cannot fire until pdf.js has already built the whole array.
 */
const MAX_PDF_ITEMS_PER_PAGE = 200_000;

/** The typed failure both decoded-text bounds return. */
function overBudget(): ExtractResult {
  return {
    ok: false,
    message: `could not be extracted as a PDF (its text decodes to over ${MAX_PDF_TEXT_CHARS} characters — over the extraction limit)`,
  };
}

export async function extractPdf(bytes: Buffer): Promise<ExtractResult> {
  // The same bounded-read guard the zip-based extractors apply per part: a
  // PDF has no compressed container to pre-scan, so the bound is simply the
  // file's raw size, checked before pdf.js parses anything.
  if (bytes.length > MAX_DOC_PART_BYTES) {
    return {
      ok: false,
      message: `could not be extracted as a PDF (the file is ${bytes.length} bytes — over the ${MAX_DOC_PART_BYTES}-byte (50 MB) extraction limit)`,
    };
  }
  let doc: Awaited<ReturnType<typeof openPdf>>;
  try {
    doc = await openPdf(bytes);
  } catch (err) {
    return { ok: false, message: `could not be parsed as a PDF (${(err as Error).message})` };
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      return {
        ok: false,
        message: `could not be extracted as a PDF (it declares ${doc.numPages} pages — over the ${MAX_PDF_PAGES}-page extraction limit)`,
      };
    }
    const lines: string[] = [];
    let textChars = 0;
    let anyText = false;
    for (let n = 1; n <= doc.numPages; n++) {
      lines.push(`[page ${n}]`);
      // The marker is retained text like any other line: a document whose cost
      // is its page count must reach the same bound as one whose cost is prose.
      textChars += n.toString().length + 8;
      if (textChars > MAX_PDF_TEXT_CHARS) return overBudget();
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      // `getTextContent` materializes the WHOLE page before returning, so a
      // single crafted page can outrun the budget between two checks. pdf.js
      // offers no streaming item API here, so the page's own item count is the
      // bound: past it the page is not walked at all.
      if (items.length > MAX_PDF_ITEMS_PER_PAGE) {
        page.cleanup();
        return {
          ok: false,
          message: `could not be extracted as a PDF (page ${n} holds ${items.length} text items — over the ${MAX_PDF_ITEMS_PER_PAGE}-item extraction limit)`,
        };
      }
      let line = '';
      let lastY: number | undefined;
      const flush = (): void => {
        if (line.trim() !== '') {
          lines.push(line);
          anyText = true;
        }
        line = '';
      };
      for (const item of items) {
        if (!('str' in item)) continue; // marked-content item — no text
        const y = item.transform?.[5];
        // Y-position jump = new visual line (1pt tolerance for kerning wobble).
        if (typeof y === 'number') {
          if (lastY !== undefined && Math.abs(y - lastY) > 1) flush();
          lastY = y;
        }
        if (item.str !== '') {
          // COUNTED before it is kept: the bound exists to stop the decoded
          // text from accumulating, so it must fire mid-page, not after —
          // and counting nothing (as this once did) fired never.
          textChars += item.str.length;
          if (textChars > MAX_PDF_TEXT_CHARS) {
            return {
              ok: false,
              message: `could not be extracted as a PDF (its text decodes to over ${MAX_PDF_TEXT_CHARS} characters — over the extraction limit)`,
            };
          }
          line += (line === '' ? '' : ' ') + item.str;
        }
        if (item.hasEOL) flush();
      }
      flush();
      page.cleanup();
    }
    const pages = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
    return anyText
      ? { ok: true, summary: `${pages}; layout, images and formatting omitted`, text: lines.join('\n') }
      : { ok: true, summary: `${pages}; no text layer (scanned document?)`, text: lines.join('\n') };
  } catch (err) {
    return { ok: false, message: `could not extract the PDF's text (${(err as Error).message})` };
  } finally {
    await doc.destroy();
  }
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | undefined;

async function openPdf(bytes: Buffer) {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  const { getDocument } = await pdfjsPromise;
  return getDocument({
    // Copy into a fresh Uint8Array: pdf.js TRANSFERS the buffer it is given
    // (detaching it), and the caller's Buffer must stay usable for hashing.
    data: new Uint8Array(bytes),
    // Server side: no font rendering — text content is all we consume.
    disableFontFace: true,
    useSystemFonts: true,
  }).promise;
}
