import AdmZip from 'adm-zip';
import type { ExtractResult } from './doc-extract.types.js';
import {
  MAX_DOC_TOTAL_BYTES,
  XML_NCNAME,
  paragraphRunText,
  xmlAttrValueByLocalName,
  xmlBlocks,
  zipEntryOversize,
} from './ooxml-text.js';

/**
 * Extract the text of a `.pptx` (PowerPoint) deck.
 *
 * Slides live at `ppt/slides/slideN.xml`; each is emitted under a `[slide N]`
 * marker line, sorted numerically (slide order in the package). Speaker notes
 * follow their slide under `[slide N notes]` when non-empty. A slide's notes
 * part is resolved through the slide's RELATIONSHIPS part
 * (`ppt/slides/_rels/slideN.xml.rels`, relationship type ending `notesSlide`)
 * — the package is free to number notes parts differently from slides — with
 * the numeric `notesSlideN.xml` convention as the fallback when the slide has
 * no rels part at all. Within a slide, each `<a:p>` paragraph is a line;
 * `<a:t>` runs concatenate with no separator (runs split mid-word).
 *
 * Bounded: every entry's DECLARED uncompressed size is checked before
 * inflation (see `zipEntryOversize`), and the parts read for one deck may not
 * exceed `MAX_DOC_TOTAL_BYTES` in total — over either bound is a typed
 * failure, never an allocation.
 */
export function extractPptx(bytes: Buffer): ExtractResult {
  let slides: Map<number, string>;
  let notesBySlide: Map<number, string>;
  try {
    const zip = new AdmZip(bytes);
    const budget = { remaining: MAX_DOC_TOTAL_BYTES };
    slides = collectNumbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/, budget);
    notesBySlide = collectNotes(zip, [...slides.keys()], budget);
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
    const notesXml = notesBySlide.get(n);
    const noteLines = notesXml !== undefined ? paragraphLines(notesXml) : [];
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

/** Running total of uncompressed bytes one extraction may still read. */
interface ReadBudget {
  remaining: number;
}

/** `entry`'s bytes as UTF-8, after the per-part and aggregate bounds. Throws over either. */
function readEntryBounded(entry: AdmZip.IZipEntry, budget: ReadBudget): string {
  const oversize = zipEntryOversize(entry);
  if (oversize) throw new Error(oversize);
  budget.remaining -= entry.header.size;
  if (budget.remaining < 0) {
    throw new Error(`the archive's parts exceed the ${MAX_DOC_TOTAL_BYTES}-byte (200 MB) total extraction limit`);
  }
  return entry.getData().toString('utf8');
}

/**
 * Entries matching `re` (capture 1 = number), decoded as UTF-8, keyed by
 * number. Two part names can parse to the SAME number (`slide1.xml` and
 * `slide01.xml`); the winner is the FIRST in ascending part-name order —
 * deterministic regardless of zip entry order, and the same policy as the
 * browser twin (`pptxOutline.ts`), so viewer and `read_file` agree. Losing
 * duplicates are never inflated (no budget charge).
 */
function collectNumbered(zip: AdmZip, re: RegExp, budget: ReadBudget): Map<number, string> {
  const matched: Array<[number, string, AdmZip.IZipEntry]> = [];
  for (const entry of zip.getEntries()) {
    const m = re.exec(entry.entryName);
    if (m) matched.push([parseInt(m[1], 10), entry.entryName, entry]);
  }
  matched.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const out = new Map<number, string>();
  for (const [n, , entry] of matched) {
    if (!out.has(n)) out.set(n, readEntryBounded(entry, budget));
  }
  return out;
}

const NOTES_REL_TYPE_SUFFIX = '/notesSlide';

/**
 * Slide number → its notes part's XML, resolved through each slide's `.rels`
 * part; numeric-name fallback ONLY for a slide without a rels part.
 */
function collectNotes(zip: AdmZip, slideNumbers: number[], budget: ReadBudget): Map<number, string> {
  const out = new Map<number, string>();
  for (const n of slideNumbers) {
    const rels = zip.getEntry(`ppt/slides/_rels/slide${n}.xml.rels`);
    let notesPart: string | undefined;
    if (rels) {
      const target = notesTargetFromRels(readEntryBounded(rels, budget));
      notesPart = target !== undefined ? resolveRelTarget('ppt/slides', target) : undefined;
    } else {
      notesPart = `ppt/notesSlides/notesSlide${n}.xml`;
    }
    if (notesPart === undefined) continue;
    const entry = zip.getEntry(notesPart);
    if (entry) out.set(n, readEntryBounded(entry, budget));
  }
  return out;
}

/**
 * The Target of the first `notesSlide`-typed Relationship in a rels part, or
 * undefined. Matched by LOCAL name — a producer that binds the relationships
 * namespace to a prefix writes `<r:Relationship r:Type=… r:Target=…>`, and
 * dropping those would silently drop the deck's notes.
 */
export function notesTargetFromRels(relsXml: string): string | undefined {
  // The prefix is a full XML NCName, not `\w`: a producer binding the
  // relationships namespace to a non-ASCII prefix is legal XML, and an
  // ASCII-only match here silently dropped that deck's speaker notes.
  const relRe = new RegExp(`<(?:${XML_NCNAME}:)?Relationship(?=[\\s/>])[^>]*>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(relsXml)) !== null) {
    const type = xmlAttrValueByLocalName(m[0], 'Type');
    if (type !== undefined && type.endsWith(NOTES_REL_TYPE_SUFFIX)) {
      return xmlAttrValueByLocalName(m[0], 'Target');
    }
  }
  return undefined;
}

/** Resolve an OPC relationship Target against the part's base directory. */
export function resolveRelTarget(baseDir: string, target: string): string {
  const parts = target.startsWith('/')
    ? target.slice(1).split('/')
    : [...baseDir.split('/'), ...target.split('/')];
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}
