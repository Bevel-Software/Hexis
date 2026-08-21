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

/** Entries matching `re` (capture 1 = number), decoded as UTF-8, keyed by number. */
async function collectNumbered(zip: JSZip, re: RegExp): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const reads: Promise<void>[] = [];
  zip.forEach((entryName, entry) => {
    const m = re.exec(entryName);
    if (m) {
      const n = parseInt(m[1], 10);
      reads.push(
        entry.async('string').then((xml) => {
          out.set(n, xml);
        }),
      );
    }
  });
  await Promise.all(reads);
  return out;
}

/**
 * Parse `.pptx` bytes into the outline. Throws an `Error` whose message reads
 * "could not be parsed as a .pptx (…)" — the caller shows it verbatim — when
 * the bytes are not a zip or hold no slides.
 */
export async function extractPptxOutline(bytes: ArrayBuffer | Uint8Array): Promise<PptxSlide[]> {
  let slides: Map<number, string>;
  let notes: Map<number, string>;
  try {
    const zip = await JSZip.loadAsync(bytes);
    slides = await collectNumbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/);
    notes = await collectNumbered(zip, /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
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
