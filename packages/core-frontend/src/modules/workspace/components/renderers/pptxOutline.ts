import JSZip from 'jszip';
import { XML_NCNAME, decodeXmlEntities } from './xmlEntities';

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
 * The XML helpers are hand-rolled for the same reason as the backend's
 * `ooxml-text.ts`: the only question asked is "the character content of
 * `<a:t>` runs, grouped by paragraph", and a full XML parser dependency would
 * be a heavyweight addition for what a linear regex scan does correctly on
 * well-formed OOXML (which a zip that PowerPoint produced always is; a
 * malformed one fails at the zip layer or yields fewer runs, never a crash).
 */

export interface PptxSlide {
  /** 1-based slide number from the package's `slideN.xml` name. */
  number: number;
  /** Non-empty paragraph texts, in document order. */
  paragraphs: string[];
  /** Speaker-note paragraphs, empty when the slide has none. */
  notes: string[];
}

/** Split an XML fragment into its `<{tag}>…</{tag}>` blocks (non-greedy, no nesting). */
function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/**
 * The text of one paragraph: every `<a:t>` run's character content,
 * concatenated with NO separator — runs split mid-word, so any separator
 * would break words apart.
 */
function paragraphRunText(paragraphXml: string): string {
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraphXml)) !== null) out += decodeXmlEntities(m[1]);
  return out;
}

/** Non-empty paragraph texts of one slide/notes part, in document order. */
function paragraphLines(xml: string): string[] {
  const out: string[] = [];
  for (const p of xmlBlocks(xml, 'a:p')) {
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
    const chunks: Uint8Array[] = [];
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
        chunks.push(chunk);
      })
      .on('error', (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        const all = new Uint8Array(entryBytes);
        let off = 0;
        for (const c of chunks) {
          all.set(c, off);
          off += c.length;
        }
        resolve(new TextDecoder().decode(all));
      })
      .resume();
  });
}

const NOTES_REL_TYPE_SUFFIX = '/notesSlide';

/**
 * One tag's attributes as `name → raw value` tokens, in document order — the
 * same left-to-right tokenizer as the backend's `ooxml-text.ts`: quoted
 * values (either quote style, whitespace around `=` tolerated) are skipped
 * over WHOLE, so an attribute-looking sequence INSIDE another attribute's
 * value can never be mistaken for an attribute of its own. Values are raw
 * (entities not decoded); a malformed tail (unterminated quote) ends the scan.
 */
function xmlAttrTokens(tagXml: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  let i = 0;
  // Skip '<' (with an optional '/' or '?') and the tag name itself.
  if (tagXml[i] === '<') {
    i++;
    if (tagXml[i] === '/' || tagXml[i] === '?') i++;
  }
  while (i < tagXml.length && !/[\s/>]/.test(tagXml[i])) i++;
  while (i < tagXml.length) {
    while (i < tagXml.length && /[\s/]/.test(tagXml[i])) i++;
    if (i >= tagXml.length || tagXml[i] === '>') return out;
    const nameStart = i;
    while (i < tagXml.length && !/[\s=/>]/.test(tagXml[i])) i++;
    const name = tagXml.slice(nameStart, i);
    while (i < tagXml.length && /\s/.test(tagXml[i])) i++;
    if (tagXml[i] !== '=') continue; // no value (not legal XML) — skip the token
    i++;
    while (i < tagXml.length && /\s/.test(tagXml[i])) i++;
    const quote = tagXml[i];
    if (quote !== '"' && quote !== "'") return out; // unquoted/malformed — stop
    const valueStart = ++i;
    const end = tagXml.indexOf(quote, i);
    if (end === -1) return out; // unterminated quote — stop
    if (name !== '') out.push({ name, value: tagXml.slice(valueStart, end) });
    i = end + 1;
  }
  return out;
}

/** The value of the attribute whose LOCAL name (after any prefix) is `localName`, or undefined. */
function xmlAttrValueByLocalName(tagXml: string, localName: string): string | undefined {
  for (const attr of xmlAttrTokens(tagXml)) {
    // `xmlns="…"` / `xmlns:Foo="…"` are namespace DECLARATIONS, not attributes
    // — under local-name matching, `xmlns:Target` would otherwise read as a
    // `Target` attribute and hand back a namespace URI.
    if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) continue;
    if (attr.name.slice(attr.name.lastIndexOf(':') + 1) === localName) return attr.value;
  }
  return undefined;
}

/**
 * The Target of the first `notesSlide`-typed Relationship in a rels part, or
 * undefined. Matched by LOCAL name — a producer that binds the relationships
 * namespace to a prefix writes `<r:Relationship r:Type=… r:Target=…>`, and
 * dropping those would silently drop the deck's notes.
 */
function notesTargetFromRels(relsXml: string): string | undefined {
  // The prefix is a full XML NCName, not `\w`: a producer binding the
  // relationships namespace to a non-ASCII prefix is legal XML, and an
  // ASCII-only match here silently dropped that deck's speaker notes.
  const relRe = new RegExp(`<(?:${XML_NCNAME}:)?Relationship(?=[\\s/>])[^>]*>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(relsXml)) !== null) {
    const type = xmlAttrValueByLocalName(m[0], 'Type');
    if (type !== undefined && type.endsWith(NOTES_REL_TYPE_SUFFIX)) return xmlAttrValueByLocalName(m[0], 'Target');
  }
  return undefined;
}

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
 * Slide `n`'s note paragraphs. Notes are paired through the slide's `.rels`
 * part (relationship type ending `notesSlide` — the package may number notes
 * parts differently from slides); the numeric `notesSlideN.xml` convention is
 * the fallback ONLY for a slide with no rels part at all. Mirrors the
 * backend's `extract-pptx.ts` exactly. The notes XML is parsed to its
 * paragraph strings here and never retained.
 */
async function readNoteLines(zip: JSZip, n: number, budget: ReadBudget): Promise<string[]> {
  const rels = zip.file(`ppt/slides/_rels/slide${n}.xml.rels`);
  let notesPart: string | undefined;
  if (rels) {
    const target = notesTargetFromRels(await readEntryBounded(rels, budget));
    notesPart = target !== undefined ? resolveRelTarget('ppt/slides', target) : undefined;
  } else {
    notesPart = `ppt/notesSlides/notesSlide${n}.xml`;
  }
  if (notesPart === undefined) return [];
  const entry = zip.file(notesPart);
  return entry ? paragraphLines(await readEntryBounded(entry, budget)) : [];
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
      if (m) slideEntries.push([parseInt(m[1], 10), entryName, entry]);
    });
    // `slide1.xml` and `slide01.xml` both parse to number 1 — one slide per
    // NUMBER, or the outline would emit two slides with the same number and
    // the renderer two children with the same key. The winner is the FIRST in
    // ascending part-name order — deterministic regardless of zip entry
    // order, and the same policy as the backend twin (`extract-pptx.ts`), so
    // viewer and `read_file` agree on which part a number's text comes from.
    slideEntries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const chosen = new Map<number, JSZip.JSZipObject>();
    for (const [n, , entry] of slideEntries) {
      if (!chosen.has(n)) chosen.set(n, entry);
    }
    for (const n of [...chosen.keys()].sort((a, b) => a - b)) {
      const paragraphs = paragraphLines(await readEntryBounded(chosen.get(n)!, budget));
      out.push({ number: n, paragraphs, notes: await readNoteLines(zip, n, budget) });
    }
  } catch (err) {
    throw new Error(`could not be parsed as a .pptx (${(err as Error).message})`);
  }
  if (out.length === 0) {
    throw new Error('could not be parsed as a .pptx (no ppt/slides/slideN.xml inside the archive)');
  }
  return out;
}
