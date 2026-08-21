import type { ExtractResult } from './doc-extract.types.js';
import { odfParagraphLines, readOdfContentXml } from './odf-text.js';
import { localBlocks, localElementBlocks, removeLocalElements } from './ooxml-text.js';

/**
 * Extract the text of a `.odp` (OpenDocument Presentation) deck.
 *
 * Slides are the `<draw:page>` elements of `content.xml`, in DOCUMENT order —
 * ODF orders slides in the file itself, so unlike pptx there is no numeric
 * filename sort. Each slide is emitted under a `[slide N]` marker (N = 1-based
 * position); speaker notes (`<presentation:notes>` inside the page) follow
 * under `[slide N notes]` when non-empty. Within a slide, each `<text:p>` in
 * its frames is a line; spans concatenate with no separator.
 */
export function extractOdp(bytes: Buffer): ExtractResult {
  const content = readOdfContentXml(bytes, '.odp');
  if (!content.ok) return content;

  const pages = drawPageBlocks(content.xml);
  if (pages.length === 0) {
    return { ok: false, message: 'could not be parsed as a .odp (no draw:page elements in content.xml)' };
  }

  const lines: string[] = [];
  let anyNotes = false;
  pages.forEach((page, i) => {
    // Split the notes part out FIRST so its paragraphs don't render as slide text.
    // Notes read by the parser and matched on their LOCAL name: a comment that
    // resembled `<presentation:notes>` used to be emitted as real speaker notes,
    // and a deck binding the presentation namespace to another prefix had none.
    const notesXml = localBlocks(page, 'notes')[0] ?? '';
    // The slide's own text is the page with the notes ELEMENTS removed by
    // their parsed boundaries — global string replacement of the notes BODY
    // also deleted slide text that happened to serialize identically to it.
    const slideXml = removeLocalElements(page, ['notes']);
    lines.push(`[slide ${i + 1}]`);
    lines.push(...odfParagraphLines(slideXml));
    const noteLines = odfParagraphLines(notesXml);
    if (noteLines.length > 0) {
      anyNotes = true;
      lines.push(`[slide ${i + 1} notes]`);
      lines.push(...noteLines);
    }
  });
  return {
    ok: true,
    summary: `${pages.length} slide${pages.length === 1 ? '' : 's'}${anyNotes ? ' + notes' : ''}; layout, images and formatting omitted`,
    text: lines.join('\n'),
  };
}

/**
 * The `<draw:page>…</draw:page>` bodies in document order (pages never nest).
 * A SELF-CLOSING `<draw:page/>` is a legal, fully blank slide — it yields ''
 * so the deck's numbering (and a deliberately blank deck) stays correct.
 */
function drawPageBlocks(xml: string): string[] {
  // The shared quote-aware scanner: a `/>` INSIDE a quoted attribute value (a
  // page name like `a/>b`) is part of the value, never the self-closing
  // delimiter, and a page whose close tag is missing costs one scan of the
  // document rather than one per opener (see `xmlElementBlocks`).
  return localElementBlocks(xml, ['page']).map((e) => e.body ?? '');
}
