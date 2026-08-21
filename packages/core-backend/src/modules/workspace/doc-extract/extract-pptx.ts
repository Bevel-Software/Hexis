import AdmZip from 'adm-zip';
import type { ExtractResult } from './doc-extract.types.js';
import { paragraphRunText, xmlBlocks } from './ooxml-text.js';

/**
 * Extract the text of a `.pptx` (PowerPoint) deck.
 *
 * Slides live at `ppt/slides/slideN.xml`; each is emitted under a `[slide N]`
 * marker line, sorted numerically (slide order in the package). Speaker notes
 * (`ppt/notesSlides/notesSlideN.xml`) follow their slide under
 * `[slide N notes]` when non-empty. Within a slide, each `<a:p>` paragraph is
 * a line; `<a:t>` runs concatenate with no separator (runs split mid-word).
 */
export function extractPptx(bytes: Buffer): ExtractResult {
  let slides: Map<number, string>;
  let notes: Map<number, string>;
  try {
    const zip = new AdmZip(bytes);
    slides = collectNumbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/);
    notes = collectNumbered(zip, /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
  } catch (err) {
    return { ok: false, message: `could not be parsed as a .pptx (${(err as Error).message})` };
  }
  if (slides.size === 0) {
    return { ok: false, message: 'could not be parsed as a .pptx (no ppt/slides/slideN.xml inside the archive)' };
  }

  const lines: string[] = [];
  let anyNotes = false;
  for (const n of [...slides.keys()].sort((a, b) => a - b)) {
    lines.push(`[slide ${n}]`);
    lines.push(...paragraphLines(slides.get(n)!));
    const noteLines = notes.has(n) ? paragraphLines(notes.get(n)!) : [];
    if (noteLines.length > 0) {
      anyNotes = true;
      lines.push(`[slide ${n} notes]`);
      lines.push(...noteLines);
    }
  }
  return {
    ok: true,
    summary: `${slides.size} slide${slides.size === 1 ? '' : 's'}${anyNotes ? ' + notes' : ''}; layout, images and formatting omitted`,
    text: lines.join('\n'),
  };
}

/** Non-empty paragraph texts of one slide/notes part, in document order. */
function paragraphLines(xml: string): string[] {
  const out: string[] = [];
  for (const p of xmlBlocks(xml, 'a:p')) {
    const text = paragraphRunText(p, 'a:t');
    if (text.trim() !== '') out.push(text);
  }
  return out;
}

/** Entries matching `re` (capture 1 = number), decoded as UTF-8, keyed by number. */
function collectNumbered(zip: AdmZip, re: RegExp): Map<number, string> {
  const out = new Map<number, string>();
  for (const entry of zip.getEntries()) {
    const m = re.exec(entry.entryName);
    if (m) out.set(parseInt(m[1], 10), entry.getData().toString('utf8'));
  }
  return out;
}
