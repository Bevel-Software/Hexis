import JSZip from 'jszip';

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

/** Decode the five XML named entities plus numeric (`&#65;` / `&#x41;`) references. */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (whole, body: string) => {
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code =
          body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
    }
  });
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

/** Entries matching `re` (capture 1 = number), read SEQUENTIALLY, keyed by number. */
async function collectNumbered(zip: JSZip, re: RegExp, budget: ReadBudget): Promise<Map<number, string>> {
  const entries: Array<[number, JSZip.JSZipObject]> = [];
  zip.forEach((entryName, entry) => {
    const m = re.exec(entryName);
    if (m) entries.push([parseInt(m[1], 10), entry]);
  });
  const out = new Map<number, string>();
  for (const [n, entry] of entries) out.set(n, await readEntryBounded(entry, budget));
  return out;
}

const NOTES_REL_TYPE_SUFFIX = '/notesSlide';

/**
 * The value of attribute `name` inside one tag's text — single- OR double-
 * quoted, whitespace around `=` tolerated. Raw (entities not decoded).
 */
function xmlAttrValue(tagXml: string, name: string): string | undefined {
  const re = new RegExp(`(?<![\\w:.-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(tagXml);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** The Target of the first `notesSlide`-typed Relationship in a rels part, or undefined. */
function notesTargetFromRels(relsXml: string): string | undefined {
  const relRe = /<Relationship(?=[\s/>])[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(relsXml)) !== null) {
    const type = xmlAttrValue(m[0], 'Type');
    if (type !== undefined && type.endsWith(NOTES_REL_TYPE_SUFFIX)) return xmlAttrValue(m[0], 'Target');
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
 * Slide number → notes XML. Notes are paired through each slide's `.rels`
 * part (relationship type ending `notesSlide` — the package may number notes
 * parts differently from slides); the numeric `notesSlideN.xml` convention is
 * the fallback ONLY for a slide with no rels part at all. Mirrors the
 * backend's `extract-pptx.ts` exactly.
 */
async function collectNotes(zip: JSZip, slideNumbers: number[], budget: ReadBudget): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const n of slideNumbers) {
    const rels = zip.file(`ppt/slides/_rels/slide${n}.xml.rels`);
    let notesPart: string | undefined;
    if (rels) {
      const target = notesTargetFromRels(await readEntryBounded(rels, budget));
      notesPart = target !== undefined ? resolveRelTarget('ppt/slides', target) : undefined;
    } else {
      notesPart = `ppt/notesSlides/notesSlide${n}.xml`;
    }
    if (notesPart === undefined) continue;
    const entry = zip.file(notesPart);
    if (entry) out.set(n, await readEntryBounded(entry, budget));
  }
  return out;
}

/**
 * Parse `.pptx` bytes into the outline. Throws an `Error` whose message reads
 * "could not be parsed as a .pptx (…)" — the caller shows it verbatim — when
 * the bytes are not a zip, hold no slides, or blow the decompression bounds.
 */
export async function extractPptxOutline(bytes: ArrayBuffer | Uint8Array): Promise<PptxSlide[]> {
  let slides: Map<number, string>;
  let notes: Map<number, string>;
  try {
    const zip = await JSZip.loadAsync(bytes);
    const budget: ReadBudget = { remaining: MAX_TOTAL_BYTES };
    slides = await collectNumbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/, budget);
    notes = await collectNotes(zip, [...slides.keys()], budget);
  } catch (err) {
    throw new Error(`could not be parsed as a .pptx (${(err as Error).message})`);
  }
  if (slides.size === 0) {
    throw new Error('could not be parsed as a .pptx (no ppt/slides/slideN.xml inside the archive)');
  }

  return [...slides.keys()]
    .sort((a, b) => a - b)
    .map((n) => ({
      number: n,
      paragraphs: paragraphLines(slides.get(n)!),
      notes: notes.has(n) ? paragraphLines(notes.get(n)!) : [],
    }));
}
