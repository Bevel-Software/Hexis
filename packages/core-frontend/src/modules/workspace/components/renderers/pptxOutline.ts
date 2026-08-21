import JSZip from 'jszip';
import {
  attrByLocalName,
  elementText,
  localElementBlocks,
  relationshipTarget,
} from './xmlReading';

/**
 * Client-side `.pptx` → text outline, the browser twin of the backend's
 * `doc-extract/extract-pptx.ts`. The conventions are deliberately identical —
 * slides in numeric package order, `<a:p>` paragraphs as lines, `<a:t>` runs
 * concatenated with NO separator (PowerPoint splits runs mid-word on
 * formatting boundaries), XML entities decoded, speaker notes attached to
 * their slide — so what an agent reads through `read_file` and what a human
 * sees in the viewer tell the same story. Implemented independently because
 * the backend module is Node-only (AdmZip, Buffer); this one runs on JSZip in
 * the browser.
 *
 * The XML reading lives in `xmlReading.ts` and is `htmlparser2`, matching the
 * backend's `ooxml-text.ts`. Both were hand-rolled once, on the reasoning that
 * the only question asked is "the character content of `<a:t>` runs, grouped
 * by paragraph". The flaw in that reasoning is that the deck is UPLOADED, so
 * the scan has to be right about every lexical rule of XML rather than the
 * ones PowerPoint's own output exercises — and here it runs on the reader's
 * main thread, which they cannot get back while it spins.
 */

export interface PptxSlide {
  /** 1-based slide number from the package's `slideN.xml` name. */
  number: number;
  /** Non-empty paragraph texts, in document order. */
  paragraphs: string[];
  /** Speaker-note paragraphs, empty when the slide has none. */
  notes: string[];
}

/**
 * Split an XML fragment into its `<{tag}>…</{tag}>` blocks by LOCAL name —
 * the prefix is the document's choice (see {@link localElementBlocks}) — in
 * document order. A self-closing `<{tag}/>` yields '' — an EMPTY block, which
 * is what an empty `<a:p/>` paragraph means. See {@link localElementBlocks}
 * for the non-nesting, quoting and linear-time guarantees.
 */
function xmlBlocks(xml: string, localTag: string): string[] {
  return localElementBlocks(xml, [localTag]).map((e) => e.body ?? '');
}

/**
 * The text of one paragraph: every `<a:t>` run's character content (matched
 * by LOCAL name `t`, whatever prefix the deck bound), concatenated with NO
 * separator — runs split mid-word, so any separator would break words apart.
 * A self-closing `<a:t/>` is an empty run and contributes nothing.
 */
function paragraphRunText(paragraphXml: string): string {
  return elementText(paragraphXml, 't');
}

/** Non-empty paragraph texts of one slide/notes part, in document order. */
function paragraphLines(xml: string): string[] {
  const out: string[] = [];
  for (const p of xmlBlocks(xml, 'p')) {
    const text = paragraphRunText(p);
    if (text.trim() !== '') out.push(text);
  }
  return out;
}

/**
 * Decompression bounds. A pptx is a zip, and a zip can be a bomb — a few KB
 * that inflate to gigabytes. Entries are read through JSZip's chunked
 * internal stream and ABORTED the moment a part exceeds 50 MB uncompressed
 * or the whole deck exceeds 200 MB (the same numbers the backend extractors
 * enforce), so the tab never holds more than one bounded part plus a chunk.
 * Reads are sequential for the same reason — an unbounded Promise.all over
 * every entry would inflate the whole deck at once.
 */
const MAX_PART_BYTES = 50 * 1024 * 1024; // 50 MB uncompressed, per entry
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB uncompressed, per deck

/** Aggregate inflation budget shared by every read of one deck. */
interface ReadBudget {
  remaining: number;
}

/** JSZip's chunked entry stream — implemented by every JSZipObject, absent from the public typings. */
interface EntryStream {
  on(event: 'data', cb: (chunk: Uint8Array) => void): EntryStream;
  on(event: 'end', cb: () => void): EntryStream;
  on(event: 'error', cb: (e: Error) => void): EntryStream;
  resume(): EntryStream;
  pause(): EntryStream;
}

/** `entry` decoded as UTF-8, read chunk-by-chunk under the per-part and aggregate caps. */
function readEntryBounded(entry: JSZip.JSZipObject, budget: ReadBudget): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): EntryStream }).internalStream(
      'uint8array',
    );
    // Each chunk is decoded AS IT ARRIVES (streaming decode holds multi-byte
    // sequences split across chunks) and then dropped. Collecting the chunks
    // and assembling one big buffer at the end held a near-50 MB part in
    // memory twice — bytes and copy — before the decoder added the string.
    const decoder = new TextDecoder();
    let text = '';
    let entryBytes = 0;
    let settled = false;
    stream
      .on('data', (chunk) => {
        if (settled) return;
        entryBytes += chunk.length;
        budget.remaining -= chunk.length;
        if (entryBytes > MAX_PART_BYTES || budget.remaining < 0) {
          settled = true;
          stream.pause(); // stop inflating — nothing further is wanted
          reject(new Error(`${entry.name} inflates past the extraction bound`));
          return;
        }
        text += decoder.decode(chunk, { stream: true });
      })
      .on('error', (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        resolve(text + decoder.decode());
      })
      .resume();
  });
}

/** OPC relationship type whose Target is a slide's speaker-notes part. */
const NOTES_REL_TYPE_SUFFIX = '/notesSlide';

/** Resolve an OPC relationship Target against the part's base directory. */
function resolveRelTarget(baseDir: string, target: string): string {
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

/**
 * The OPC relationships part of `partName` — `dir/_rels/base.rels`. Derived
 * from the part NAME, never from the slide number: when a deck ships both
 * `slide1.xml` and `slide01.xml`, the name-ordering rule below picks
 * `slide01.xml`, whose rels part is `slide01.xml.rels`. Rebuilding the path
 * from the number asked for `slide1.xml.rels` — a part belonging to the OTHER
 * file — and so either lost that slide's speaker notes or attached the losing
 * part's.
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
 * The note paragraphs of the slide part named `slideName`. Notes are paired
 * through that part's `.rels` (relationship type ending `notesSlide` — the
 * package may number notes parts differently from slides); the conventional
 * `notesSlideN.xml` name is the fallback ONLY for a slide with no rels part
 * at all. Mirrors the backend's `extract-pptx.ts` exactly. The notes XML is
 * parsed to its paragraph strings here and never retained.
 */
async function readNoteLines(zip: JSZip, slideName: string, budget: ReadBudget): Promise<string[]> {
  const rels = zip.file(relsPartName(slideName));
  let notesPart: string | undefined;
  if (rels) {
    const target = relationshipTarget(await readEntryBounded(rels, budget), NOTES_REL_TYPE_SUFFIX);
    notesPart = target !== undefined ? resolveRelTarget('ppt/slides', target) : undefined;
  } else {
    notesPart = conventionalNotesPart(slideName);
  }
  if (notesPart === undefined) return [];
  const entry = zip.file(notesPart);
  return entry ? paragraphLines(await readEntryBounded(entry, budget)) : [];
}

/**
 * The slide part names `presentation.xml` lists, in ITS order, or undefined
 * when the deck has no usable list.
 *
 * A deck that has been REORDERED keeps its original part filenames, so
 * `slide3.xml` may well be the first slide. The backend follows this list, and
 * a viewer that followed filenames instead would number the same deck
 * differently from what `read_file` reports — the one thing these twins exist
 * to prevent.
 */
async function presentationOrder(zip: JSZip, budget: ReadBudget): Promise<string[] | undefined> {
  const pres = zip.file('ppt/presentation.xml');
  const rels = zip.file('ppt/_rels/presentation.xml.rels');
  if (!pres || !rels) return undefined;
  try {
    const ids = localElementBlocks(await readEntryBounded(pres, budget), ['sldId'])
      .map((e) => attrByLocalName(e.attributes, 'id'))
      .filter((v): v is string => v !== undefined);
    if (ids.length === 0) return undefined;
    const relsXml = await readEntryBounded(rels, budget);
    const targetById = new Map<string, string>();
    for (const rel of localElementBlocks(relsXml, ['Relationship'])) {
      const id = attrByLocalName(rel.attributes, 'Id');
      const target = attrByLocalName(rel.attributes, 'Target');
      if (id !== undefined && target !== undefined) targetById.set(id, target);
    }
    const names = ids
      .map((id) => targetById.get(id))
      .filter((t): t is string => t !== undefined)
      .map((t) => resolveRelTarget('ppt', t));
    return names.length > 0 ? names : undefined;
  } catch {
    return undefined; // an unreadable list is simply no list
  }
}

/**
 * Parse `.pptx` bytes into the outline. Throws an `Error` whose message reads
 * "could not be parsed as a .pptx (…)" — the caller shows it verbatim — when
 * the bytes are not a zip, hold no slides, or blow the decompression bounds.
 *
 * Each slide/notes part is parsed into its final paragraph strings AS IT IS
 * READ and the decompressed XML is dropped before the next part is touched —
 * near the 200 MB aggregate cap, retaining every part's XML until the end
 * would hold the whole inflated deck in memory at once; this way the peak is
 * one bounded part plus the small parsed outline.
 */
export async function extractPptxOutline(bytes: ArrayBuffer | Uint8Array): Promise<PptxSlide[]> {
  const out: PptxSlide[] = [];
  try {
    const zip = await JSZip.loadAsync(bytes);
    const budget: ReadBudget = { remaining: MAX_TOTAL_BYTES };
    const slideEntries: Array<[number, string, JSZip.JSZipObject]> = [];
    zip.forEach((entryName, entry) => {
      const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entryName);
      if (!m) return;
      const n = parseInt(m[1], 10);
      // A crafted name can spell more digits than a double holds exactly —
      // `parseInt` then rounds DISTINCT names to the same number (or to
      // Infinity), silently dropping a part or rendering "Slide Infinity".
      // No real deck numbers slides past 2^53; such a name is not a slide.
      if (Number.isSafeInteger(n)) slideEntries.push([n, entryName, entry]);
    });
    // `slide1.xml` and `slide01.xml` both parse to number 1 — one slide per
    // NUMBER, or the outline would emit two slides with the same number and
    // the renderer two children with the same key. The winner is the FIRST in
    // ascending part-name order — deterministic regardless of zip entry
    // order, and the same policy as the backend twin (`extract-pptx.ts`), so
    // viewer and `read_file` agree on which part a number's text comes from.
    slideEntries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    // The winner's NAME is kept, not just its bytes: the notes lookup hangs
    // off the part name (see `relsPartName`), so a zero-padded winner must not
    // send it back to the number.
    const chosen = new Map<number, [string, JSZip.JSZipObject]>();
    for (const [n, name, entry] of slideEntries) {
      if (!chosen.has(n)) chosen.set(n, [name, entry]);
    }
    // Emission order mirrors the backend: the presentation's own slide list
    // when it resolves to parts this deck actually has, filename order
    // otherwise — and when the LIST orders the deck the numbers are POSITIONS
    // in it, because a reordered deck's filenames no longer mean anything
    // positional. Numbering the same deck differently from what `read_file`
    // reports is the one thing these twins exist to prevent.
    const numberByName = new Map<string, number>();
    for (const [n, [name]] of chosen) numberByName.set(name, n);
    const listed = (await presentationOrder(zip, budget)) ?? [];
    const fromList = [
      ...new Set(
        listed.map((name) => numberByName.get(name)).filter((n): n is number => n !== undefined),
      ),
    ];
    const byFilename = [...chosen.keys()].sort((a, b) => a - b);
    const positional = fromList.length > 0;
    const order = positional
      ? [...fromList, ...byFilename.filter((n) => !fromList.includes(n))]
      : byFilename;
    let position = 0;
    for (const n of order) {
      const [name, entry] = chosen.get(n)!;
      const paragraphs = paragraphLines(await readEntryBounded(entry, budget));
      position += 1;
      out.push({
        number: positional ? position : n,
        paragraphs,
        notes: await readNoteLines(zip, name, budget),
      });
    }
  } catch (err) {
    throw new Error(`could not be parsed as a .pptx (${(err as Error).message})`);
  }
  if (out.length === 0) {
    throw new Error('could not be parsed as a .pptx (no ppt/slides/slideN.xml inside the archive)');
  }
  return out;
}
