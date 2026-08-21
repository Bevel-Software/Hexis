/**
 * XML/HTML reading shared by the document renderers — the browser twin of the
 * backend's `ooxml-text.ts`, and kept a twin ON PURPOSE: the viewer and
 * `read_file` must agree about what a deck says.
 *
 * The scanning is `htmlparser2`, for the reason the backend gave up its own:
 * the input is an UPLOADED file, so a hand-rolled scan has to be right about
 * every lexical rule of XML rather than the ones a well-formed document
 * happens to exercise — quoted `>`, `/` that ends a name only as part of `/>`,
 * a close tag written inside a comment or CDATA, non-ASCII namespace prefixes
 * — and the bookkeeping each fix needed grew defects of its own. In a viewer
 * those defects run on the reader's own main thread.
 */
import { Parser } from 'htmlparser2';

/** One element found by {@link xmlElementBlocks}. */
export interface XmlElementBlock {
  /** The qualified name as written, e.g. `a:p` — which of `names` matched. */
  name: string;
  /** The element's attributes. Values are RAW (entities not decoded). */
  attributes: Record<string, string>;
  /** The body between `>` and the matching close tag; undefined when self-closing. */
  body: string | undefined;
}

/**
 * How deep the element stack may go before a part is given up on.
 *
 * Real office XML nests a few dozen levels. A crafted part can nest as deep as
 * it has bytes, and the parser holds a stack entry per open element; measured
 * on the backend copy, unclosed openers 40 k deep took 136 ms and 80 k took
 * 2.7 s. A tab cannot be closed while its main thread is pinned, so the bound
 * sits far above any real deck and far below where that curve bites.
 */
const MAX_ELEMENT_DEPTH = 1_000;

/** Thrown to stop a parse at {@link MAX_ELEMENT_DEPTH}; never leaves this module. */
const TOO_DEEP = Symbol('too deep');

/** The match currently being collected by {@link xmlElementBlocks}. */
interface OpenMatch {
  name: string;
  attributes: Record<string, string>;
  depth: number;
  /** Index of the `>` that ends the open tag — the body starts one past it. */
  tagEnd: number;
}

/** A parser configured the one way every reader here wants it. */
function xmlParser(handlers: ConstructorParameters<typeof Parser>[0]): Parser {
  return new Parser(handlers, { xmlMode: true, decodeEntities: false });
}

/**
 * The `<name …>…</name>` and self-closing `<name …/>` elements named by
 * `names`, in document order, at ANY depth — but never descending into a
 * match, since a match nested inside another is part of that one's body
 * rather than a block of its own.
 *
 * Bodies are RAW slices (entities not decoded): callers re-read them for
 * nested elements and decode only the text they keep.
 */
export function xmlElementBlocks(xml: string, names: readonly string[]): XmlElementBlock[] {
  const wanted = new Set(names);
  const out: XmlElementBlock[] = [];
  let depth = 0;
  let open: OpenMatch | null = null;
  const parser: Parser = xmlParser({
    onopentag(name, attributes) {
      depth++;
      if (open === null && wanted.has(name)) {
        open = { name, attributes, depth, tagEnd: parser.endIndex };
      }
      if (depth > MAX_ELEMENT_DEPTH) throw TOO_DEEP;
    },
    onclosetag(name) {
      if (open !== null && depth === open.depth && name === open.name) {
        // A self-closing `<a:p/>` reports its close on the SAME token as its
        // open tag; anything else — including the close the parser implies for
        // an element left open at end of input — ends further on.
        const selfClosing = parser.endIndex === open.tagEnd;
        out.push({
          name,
          attributes: open.attributes,
          body: selfClosing ? undefined : xml.slice(open.tagEnd + 1, parser.startIndex),
        });
        open = null;
      }
      depth--;
    },
  });
  try {
    parser.write(xml);
    parser.end();
  } catch (err) {
    if (err !== TOO_DEEP) throw err;
    // The element still open keeps the body it had reached. (Read through an
    // alias: the assignments happen inside the parser's callbacks, which
    // control-flow analysis cannot see from here.)
    const pending = open as OpenMatch | null;
    if (pending !== null) {
      out.push({
        name: pending.name,
        attributes: pending.attributes,
        body: xml.slice(pending.tagEnd + 1, parser.startIndex),
      });
    }
    parser.reset();
  }
  return out;
}

/**
 * The character content of every `<tag>` element in a fragment, concatenated
 * with NO separator — OOXML splits runs mid-word on formatting boundaries, so
 * any separator would break words apart.
 *
 * TEXT, never the raw body: a run's body is markup as well as characters when
 * the part is malformed enough to nest runs, and slicing it wholesale put
 * `<a:t>` tags into the rendered outline.
 */
export function elementText(xml: string, tag: string): string {
  let out = '';
  let inside = 0;
  let depth = 0;
  const parser = xmlParserDecoding({
    onopentag(name) {
      depth++;
      if (name === tag) inside++;
      if (depth > MAX_ELEMENT_DEPTH) throw TOO_DEEP;
    },
    ontext(text) {
      if (inside > 0) out += text;
    },
    onclosetag(name) {
      if (name === tag && inside > 0) inside--;
      depth--;
    },
  });
  try {
    parser.write(xml);
    parser.end();
  } catch (err) {
    if (err !== TOO_DEEP) throw err;
    parser.reset();
  }
  return out;
}

/** Like {@link xmlParser}, but decoding entities — for text, not for slicing. */
function xmlParserDecoding(handlers: ConstructorParameters<typeof Parser>[0]): Parser {
  return new Parser(handlers, { xmlMode: true, decodeEntities: true });
}

/**
 * The `Target` of the first relationship whose `Type` ends in `typeSuffix`, or
 * undefined. Matched by LOCAL name — a producer that binds the relationships
 * namespace to a prefix writes `<r:Relationship r:Type=… r:Target=…>`, and
 * dropping those would silently drop the deck's notes. Namespace DECLARATIONS
 * (`xmlns:Target=…`) are not attributes and never answer for one.
 */
export function relationshipTarget(relsXml: string, typeSuffix: string): string | undefined {
  let found: string | undefined;
  let depth = 0;
  const parser = xmlParser({
    onopentag(name, attributes) {
      depth++;
      if (depth > MAX_ELEMENT_DEPTH) throw TOO_DEEP;
      if (found !== undefined) return;
      if (localName(name) !== 'Relationship') return;
      const byLocal = (want: string): string | undefined => {
        for (const [key, value] of Object.entries(attributes)) {
          if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
          if (localName(key) === want) return value;
        }
        return undefined;
      };
      if (byLocal('Type')?.endsWith(typeSuffix) === true) found = byLocal('Target');
    },
    onclosetag() {
      depth--;
    },
  });
  try {
    parser.write(relsXml);
    parser.end();
  } catch (err) {
    if (err !== TOO_DEEP) throw err;
    parser.reset();
  }
  return found;
}

/** The part of a qualified name after its namespace prefix. */
function localName(qualified: string): string {
  return qualified.slice(qualified.lastIndexOf(':') + 1);
}
