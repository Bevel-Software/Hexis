import AdmZip from 'adm-zip';
import { Parser } from 'htmlparser2';
import { attrByLocalName, localElementBlocks, localName, zipEntryOversize } from './ooxml-text.js';

/**
 * ODF (OpenDocument) text helpers shared by the odt/odp/ods extractors.
 *
 * Elements are matched by LOCAL name — `p`, not `text:p`. A prefix is the
 * document's own choice, and naming `text:` literally meant an ODF file that
 * defaulted the namespace, or bound it to any other prefix, extracted as
 * empty. This module used to answer that by REWRITING every non-conventional
 * prefix across the whole of `content.xml` before scanning it, a pass that had
 * to be bounded against crafted alias lists and could still corrupt ordinary
 * paragraph text that happened to look like an alias. Matching local names
 * needs none of it.
 */

/**
 * The text of one ODF paragraph (`<text:p>` / `<text:h>` content). Character
 * data is concatenated with NO separator — formatting runs (`<text:span>`)
 * split words exactly like OOXML runs do, so ignoring the span tags joins them
 * back. Three ODF whitespace elements are REAL characters and render as such:
 *
 *  - `<text:tab/>`          → a tab
 *  - `<text:line-break/>`   → a newline
 *  - `<text:s text:c="N"/>` → N spaces (no `text:c` attribute = 1)
 *
 * Read through the parser, so entities decode, CDATA sections are the text
 * they hold rather than markup, and a comment is not paragraph content.
 */
/**
 * Cap on the characters the whitespace ELEMENTS may add to ONE paragraph.
 * Each `<text:s text:c="N"/>` is clamped on its own below, but nothing else
 * bounds how many such elements a paragraph may hold — a content.xml well
 * under the 50 MB part limit could still expand to gigabytes of spaces. The
 * budget caps the SUM per paragraph; real layout whitespace is nowhere near it.
 */
const MAX_PARAGRAPH_WHITESPACE_CHARS = 10_000;

export function odfParagraphText(paragraphXml: string): string {
  let out = '';
  let whitespaceBudget = MAX_PARAGRAPH_WHITESPACE_CHARS;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const local = localName(name);
        if (local === 'tab') {
          if (whitespaceBudget > 0) {
            out += '\t';
            whitespaceBudget--;
          }
        } else if (local === 'line-break') {
          if (whitespaceBudget > 0) {
            out += '\n';
            whitespaceBudget--;
          }
        } else if (local === 's') {
          const raw = attrByLocalName(attributes, 'c');
          const count = raw !== undefined ? parseInt(raw, 10) : 1;
          // Bounded defensively — a corrupt attribute must not balloon the
          // extraction — and again by the per-paragraph budget above.
          const spaces = Math.min(Number.isFinite(count) ? Math.min(Math.max(count, 0), 1000) : 1, whitespaceBudget);
          out += ' '.repeat(spaces);
          whitespaceBudget -= spaces;
        }
      },
      ontext(text) {
        out += text;
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(paragraphXml);
  parser.end();
  return out;
}

/**
 * The `<text:p>` / `<text:h>` paragraph bodies of an XML fragment, in DOCUMENT
 * order (headings interleaved with paragraphs, as written). Self-closing
 * elements (an empty paragraph) yield ''. `<text:page-number>` and friends do
 * not count as paragraphs.
 */
export function odfParagraphBlocks(xml: string): string[] {
  return localElementBlocks(xml, ['p', 'h']).map((e) => e.body ?? '');
}


/** Non-empty paragraph texts of an ODF fragment — what odp slides/notes render. */
export function odfParagraphLines(xml: string): string[] {
  const out: string[] = [];
  for (const p of odfParagraphBlocks(xml)) {
    const text = odfParagraphText(p);
    if (text.trim() !== '') out.push(text);
  }
  return out;
}

/**
 * `content.xml` of an ODF package or a typed could-not-parse failure message
 * (`kind` names the extension for the message, e.g. '.odt').
 *
 * Bounded: the entry's DECLARED uncompressed size is checked against
 * `MAX_DOC_PART_BYTES` (50 MB) before anything inflates, so a zip bomb is a
 * typed refusal, never an allocation.
 */
export function readOdfContentXml(
  bytes: Buffer,
  kind: '.odt' | '.odp' | '.ods',
): { ok: true; xml: string } | { ok: false; message: string } {
  try {
    const zip = new AdmZip(bytes);
    const entry = zip.getEntry('content.xml');
    if (!entry) {
      return { ok: false, message: `could not be parsed as a ${kind} (no content.xml inside the archive)` };
    }
    const oversize = zipEntryOversize(entry);
    if (oversize) return { ok: false, message: `could not be extracted as a ${kind} (${oversize})` };
    return { ok: true, xml: entry.getData().toString('utf8') };
  } catch (err) {
    return { ok: false, message: `could not be parsed as a ${kind} (${(err as Error).message})` };
  }
}
