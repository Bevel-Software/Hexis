import type { ExtractResult } from './doc-extract.types.js';

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
export async function extractPdf(bytes: Buffer): Promise<ExtractResult> {
  let doc: Awaited<ReturnType<typeof openPdf>>;
  try {
    doc = await openPdf(bytes);
  } catch (err) {
    return { ok: false, message: `could not be parsed as a PDF (${(err as Error).message})` };
  }
  try {
    const lines: string[] = [];
    let anyText = false;
    for (let n = 1; n <= doc.numPages; n++) {
      lines.push(`[page ${n}]`);
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
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
        if (item.str !== '') line += (line === '' ? '' : ' ') + item.str;
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
