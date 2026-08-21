import AdmZip from 'adm-zip';
import type { ExtractResult } from './doc-extract.types.js';
import {
  MAX_DOC_TOTAL_BYTES,
  attrByLocalName,
  decodeXmlEntities,
  localBlocks,
  localElementBlocks,
  paragraphRunText,
  zipEntryOversize,
} from './ooxml-text.js';

/**
 * Extract the text of a `.pptx` (PowerPoint) deck.
 *
 * Slides live at `ppt/slides/slideN.xml`; each is emitted under a `[slide N]`
 * marker line, sorted numerically (slide order in the package). Speaker notes
 * follow their slide under `[slide N notes]` when non-empty. A slide's notes
 * part is resolved through the slide's RELATIONSHIPS part (the `_rels` twin of
 * the slide part's own NAME, relationship type ending `notesSlide`) — the
 * package is free to number notes parts differently from slides — with the
 * `notesSlideN.xml` convention as the fallback when the slide has no rels
 * part at all. Within a slide, each `<a:p>` paragraph is a line;
 * `<a:t>` runs concatenate with no separator (runs split mid-word).
 *
 * Bounded: every entry's DECLARED uncompressed size is checked before
 * inflation (see `zipEntryOversize`), and the parts read for one deck may not
 * exceed `MAX_DOC_TOTAL_BYTES` in total — over either bound is a typed
 * failure, never an allocation.
 */
export function extractPptx(bytes: Buffer): ExtractResult {
  let slides: Map<number, SlidePart>;
  let notesBySlide: Map<number, string>;
  try {
    const zip = new AdmZip(bytes);
    const budget = { remaining: MAX_DOC_TOTAL_BYTES };
    slides = collectNumbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/, budget);
    notesBySlide = collectNotes(zip, slides, budget);
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
    lines.push(...paragraphLines(slides.get(n)!.xml));
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
  for (const p of localBlocks(xml, 'p')) {
    const text = paragraphRunText(p, 't');
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

/** The part CHOSEN for a slide number: its name as well as its bytes. */
interface SlidePart {
  /** Full part name, e.g. `ppt/slides/slide01.xml`. */
  name: string;
  xml: string;
}

/**
 * Entries matching `re` (capture 1 = number), decoded as UTF-8, keyed by
 * number. Two part names can parse to the SAME number (`slide1.xml` and
 * `slide01.xml`); the winner is the FIRST in ascending part-name order —
 * deterministic regardless of zip entry order, and the same policy as the
 * browser twin (`pptxOutline.ts`), so viewer and `read_file` agree. Losing
 * duplicates are never inflated (no budget charge).
 *
 * The winner's NAME rides along with its bytes because everything else about
 * a slide hangs off the part name, not the number: see `collectNotes`.
 */
function collectNumbered(zip: AdmZip, re: RegExp, budget: ReadBudget): Map<number, SlidePart> {
  const matched: Array<[number, string, AdmZip.IZipEntry]> = [];
  for (const entry of zip.getEntries()) {
    const m = re.exec(entry.entryName);
    if (m) matched.push([parseInt(m[1], 10), entry.entryName, entry]);
  }
  matched.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const out = new Map<number, SlidePart>();
  for (const [n, name, entry] of matched) {
    if (!out.has(n)) out.set(n, { name, xml: readEntryBounded(entry, budget) });
  }
  return out;
}

const NOTES_REL_TYPE_SUFFIX = '/notesSlide';

/**
 * The OPC relationships part of `partName` — `dir/_rels/base.rels`. Derived
 * from the part NAME, never from the slide number: when a deck ships both
 * `slide1.xml` and `slide01.xml`, the name-ordering rule picks `slide01.xml`,
 * whose rels part is `slide01.xml.rels`. Rebuilding the path from the number
 * asked for `slide1.xml.rels` — a part belonging to the OTHER file — and so
 * either lost that slide's speaker notes or attached the losing part's.
 */
function relsPartName(partName: string): string {
  const cut = partName.lastIndexOf('/');
  return `${partName.slice(0, cut)}/_rels/${partName.slice(cut + 1)}.rels`;
}

/**
 * The conventional notes part for a slide part — `slide01.xml` →
 * `notesSlide01.xml`. Derived from the name for the same reason as the rels
 * path, so a zero-padded deck's fallback lands on the matching notes part.
 */
function conventionalNotesPart(partName: string): string {
  const base = partName.slice(partName.lastIndexOf('/') + 1);
  return `ppt/notesSlides/notes${base[0].toUpperCase()}${base.slice(1)}`;
}

/**
 * Slide number → its notes part's XML, resolved through each slide's `.rels`
 * part; the conventional-name fallback ONLY for a slide without a rels part.
 * Both paths come from the SELECTED part's name (see `relsPartName`).
 */
function collectNotes(zip: AdmZip, slides: Map<number, SlidePart>, budget: ReadBudget): Map<number, string> {
  const out = new Map<number, string>();
  for (const [n, slide] of slides) {
    const rels = zip.getEntry(relsPartName(slide.name));
    let notesPart: string | undefined;
    if (rels) {
      const target = notesTargetFromRels(readEntryBounded(rels, budget));
      notesPart = target !== undefined ? resolveRelTarget('ppt/slides', target) : undefined;
    } else {
      notesPart = conventionalNotesPart(slide.name);
    }
    if (notesPart === undefined) continue;
    const entry = zip.getEntry(notesPart);
    if (entry) out.set(n, readEntryBounded(entry, budget));
  }
  return out;
}

/**
 * The Target of the first `notesSlide`-typed Relationship in a rels part, or
 * undefined.
 *
 * Read by the parser: matched on the element's LOCAL name, so a producer that
 * binds the relationships namespace to a prefix (`<r:Relationship r:Type=…>`)
 * is read like any other — and a `<Relationship>`-looking fragment written
 * inside a COMMENT or a CDATA section is text, not live metadata pointing the
 * notes lookup at a part of its author's choosing.
 */
export function notesTargetFromRels(relsXml: string): string | undefined {
  for (const rel of localElementBlocks(relsXml, ['Relationship'])) {
    const type = attrByLocalName(rel.attributes, 'Type');
    if (type !== undefined && type.endsWith(NOTES_REL_TYPE_SUFFIX)) {
      // Attribute values are RAW here (the block reader does not decode), and a
      // part name may legally contain `&`, written `&amp;` in the rels.
      const target = attrByLocalName(rel.attributes, 'Target');
      return target !== undefined ? decodeXmlEntities(target) : undefined;
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
