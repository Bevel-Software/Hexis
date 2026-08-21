import AdmZip from 'adm-zip';
import { decodeXmlEntities, TAG_ATTRS, xmlAttrValue, zipEntryOversize } from './ooxml-text.js';

/**
 * Minimal ODF (OpenDocument) text helpers shared by the odt/odp/ods
 * extractors. Same DELIBERATELY hand-rolled approach as `ooxml-text.ts`: an
 * ODF package's `content.xml` is well-formed XML (LibreOffice/OpenOffice wrote
 * it), and the extractors only need paragraph character content plus three
 * whitespace elements — a linear regex scan does that correctly without a new
 * XML-parser dependency.
 */

/**
 * The text of one ODF paragraph (`<text:p>` / `<text:h>` content). Character
 * data between tags is entity-decoded and concatenated with NO separator —
 * formatting runs (`<text:span>`) split words exactly like OOXML runs do, so
 * ignoring the span tags joins them back. Three ODF whitespace elements are
 * REAL characters and are rendered as such:
 *
 *  - `<text:tab/>`        → a tab
 *  - `<text:line-break/>` → a newline
 *  - `<text:s text:c="N"/>` → N spaces (no `text:c` attribute = 1)
 */
export function odfParagraphText(paragraphXml: string): string {
  let out = '';
  let last = 0;
  const tagRe = /<[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(paragraphXml)) !== null) {
    out += decodeXmlEntities(paragraphXml.slice(last, m.index));
    last = tagRe.lastIndex;
    const name = /^<\/?([^\s/>]+)/.exec(m[0])?.[1];
    if (name === 'text:tab') out += '\t';
    else if (name === 'text:line-break') out += '\n';
    else if (name === 'text:s') {
      const c = xmlAttrValue(m[0], 'text:c');
      const count = c !== undefined ? parseInt(c, 10) : 1;
      // A count is bounded defensively — a corrupt attribute must not balloon the extraction.
      out += ' '.repeat(Number.isFinite(count) ? Math.min(Math.max(count, 0), 1000) : 1);
    }
  }
  return out + decodeXmlEntities(paragraphXml.slice(last));
}

/**
 * The `<text:p>` / `<text:h>` paragraph bodies of an XML fragment, in DOCUMENT
 * order (headings interleaved with paragraphs, as written). Self-closing
 * elements (`<text:p/>`, an empty paragraph) yield ''. The lookahead keeps
 * `<text:page-number>` and friends from counting as paragraphs; non-greedy
 * close is correct because ODF paragraphs cannot nest.
 */
export function odfParagraphBlocks(xml: string): string[] {
  // Attributes are matched LAZILY so a self-closing paragraph WITH attributes
  // (`<text:p text:style-name="s"/>`) hits the `/>` branch instead of its
  // body swallowing everything up to the next paragraph's close tag; the
  // quote-aware TAG_ATTRS fragment keeps a `/>` INSIDE a quoted attribute
  // value from being mistaken for that branch.
  const re = new RegExp(`<text:(p|h)(?=[\\s/>])${TAG_ATTRS}(?:\\/>|>([\\s\\S]*?)<\\/text:\\1>)`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[2] ?? '');
  return out;
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
 * The ODF namespace URIs whose bound prefixes the extractors' regexes name
 * literally (`text:p`, `table:table`, `draw:page`, `presentation:notes`,
 * `office:text`…). Namespace-well-formed XML may bind ANY prefix to these
 * URIs; `normalizeOdfPrefixes` maps whatever the document chose back onto the
 * conventional ones so the scans stay correct.
 */
const ODF_CONVENTIONAL_PREFIX: Record<string, string> = {
  'urn:oasis:names:tc:opendocument:xmlns:office:1.0': 'office',
  'urn:oasis:names:tc:opendocument:xmlns:text:1.0': 'text',
  'urn:oasis:names:tc:opendocument:xmlns:table:1.0': 'table',
  'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0': 'draw',
  'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0': 'presentation',
};

/**
 * The most `xmlns:*` aliases one content.xml may bind to the five ODF URIs.
 * Real producers declare each namespace ONCE; dozens of aliases only ever
 * appear in crafted input, so past this bound the document is refused (a
 * thrown Error, which `readOdfContentXml` turns into the typed parse failure).
 */
export const MAX_ODF_NS_ALIASES = 64;

/**
 * Rewrite non-conventional namespace prefixes to the conventional ODF ones.
 *
 * Reads the ROOT element's `xmlns:*` declarations (where every real-world ODF
 * producer declares them — nested redeclarations are out of scope for the
 * hand-rolled scanner) and, for each prefix bound to one of the five ODF URIs
 * above under a different name, deterministically rewrites that prefix
 * wherever it starts a tag name (`<p:`, `</p:`) or an attribute name
 * (`␣p:name=`). ONE combined pass over the document — a single alternation
 * regex built from every alias's escaped name — so N declared aliases cost one
 * scan, never N full-document rewrites (a crafted content.xml declaring many
 * aliases must not become quadratic CPU). The single pass also makes
 * simultaneous renames (documents that SWAP two conventional prefixes) safe
 * for free: replaced text is never rescanned.
 *
 * Throws when the root binds more than {@link MAX_ODF_NS_ALIASES} aliases to
 * the ODF URIs — see there.
 */
export function normalizeOdfPrefixes(xml: string): string {
  const root = /<[A-Za-z_][^\s/>]*((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(xml);
  if (!root) return xml;
  const declRe = /xmlns:([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  // alias → canonical prefix; the FIRST declaration wins on a duplicate alias
  // (namespace-well-formed XML cannot redeclare a prefix on one element).
  const canonicalByAlias = new Map<string, string>();
  let declared = 0;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(root[1])) !== null) {
    const to = ODF_CONVENTIONAL_PREFIX[m[2] ?? m[3]];
    if (to === undefined) continue;
    if (++declared > MAX_ODF_NS_ALIASES) {
      throw new Error(
        `content.xml binds more than ${MAX_ODF_NS_ALIASES} namespace aliases to the ODF namespaces`,
      );
    }
    if (to !== m[1] && !canonicalByAlias.has(m[1])) canonicalByAlias.set(m[1], to);
  }
  if (canonicalByAlias.size === 0) return xml;
  // Longest-first so an alias that PREFIXES another (`t` vs `t2`) can never be
  // shadowed in the alternation; every alias is regex-escaped.
  const alternation = [...canonicalByAlias.keys()]
    .sort((a, b) => b.length - a.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  // A prefix use is always preceded by `<`, `</`, or attribute-separating
  // whitespace — never by part of another name.
  const useRe = new RegExp(`([<\\s/])(${alternation}):`, 'g');
  return xml.replace(useRe, (_whole, before: string, alias: string) => `${before}${canonicalByAlias.get(alias)}:`);
}

/**
 * `content.xml` of an ODF package — namespace-prefix-normalized (see
 * `normalizeOdfPrefixes`) — or a typed could-not-parse failure message
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
    return { ok: true, xml: normalizeOdfPrefixes(entry.getData().toString('utf8')) };
  } catch (err) {
    return { ok: false, message: `could not be parsed as a ${kind} (${(err as Error).message})` };
  }
}
