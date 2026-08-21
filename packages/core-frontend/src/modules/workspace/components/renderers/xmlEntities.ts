/**
 * Dependency-free XML/HTML text-scanning primitives shared by the document
 * renderers — the browser twin of the backend's `ooxml-text.ts` fragments.
 *
 * Deliberately import-free: `emailMessage.ts` (the email viewer's model) and
 * `pptxOutline.ts` (which pulls in JSZip) both need these, and sharing them
 * THROUGH `pptxOutline.ts` made the email chunk evaluate — and bundle —
 * presentation code it never uses.
 */

/**
 * Decode the five XML named entities plus numeric (`&#65;` / `&#x41;`)
 * references. Decimal references admit ONLY decimal digits and hex digits only
 * after `#x` — a malformed `&#12A;` must stay literal text, not be consumed
 * with `parseInt` silently stopping at the `A` and emitting U+000C.
 */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/g, (whole, body: string) => {
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
        const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
    }
  });
}

/**
 * Regex FRAGMENT matching one XML NCName — the legal shape of a namespace
 * prefix. `\w` would be wrong here: XML names admit most of Unicode (letters,
 * combining marks, …), and a producer is free to bind a namespace to a
 * non-ASCII prefix — an ASCII-only prefix match would silently drop such
 * elements. Astral characters ride along as surrogate pairs so the fragment
 * works without the `u` flag.
 */
const NC_START =
  'A-Za-z_' +
  '\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D' +
  '\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD';
const NC_EXTRA = '0-9.\u00B7\u0300-\u036F\u203F-\u2040-'; // dash LAST: literal in the class, never a range
export const XML_NCNAME =
  `(?:[${NC_START}]|[\uD800-\uDB7F][\uDC00-\uDFFF])` +
  `(?:[${NC_START}${NC_EXTRA}]|[\uD800-\uDB7F][\uDC00-\uDFFF])*`;

/** One element found by {@link xmlElementBlocks}. */
export interface XmlElementBlock {
  /** The qualified name as written, e.g. `a:p` \u2014 which of `names` matched. */
  name: string;
  /** The attribute region verbatim (leading space included), '' when there is none. */
  attrs: string;
  /** The body between `>` and the matching close tag; undefined when self-closing. */
  body: string | undefined;
}

/**
 * What may follow an element name for the name to have ENDED there \u2014 the
 * regex `(?:\s[^>]*)?>` alternation's job, plus `/` for the self-closing
 * shape. Hoisted to module scope because {@link xmlElementBlocks} consults it
 * once per `<` in the part.
 */
const NAME_DELIMITER = /[\s/>]/;

/**
 * Index of the `>` that ends the tag whose attribute region starts at `from`,
 * or -1 when the tag never terminates. Quote-aware, so a `>` or `/>` INSIDE a
 * quoted attribute value is part of the value and never the delimiter.
 *
 * Every `<` passed OUTSIDE quotes is memoized in `known` with THIS scan's
 * answer, whether that answer is a `>` or -1. Such a `<` was reached in the
 * no-quote state, and an element name holds no quote, `<` or `>` — so a tag
 * starting there resumes the identical character walk in the identical state
 * and can only reach the identical end. That memo is what keeps the whole
 * pass linear.
 *
 * Memoizing the SUCCESSES matters as much as the failures: a wall of openers
 * whose attribute scans all run to one far-away `>` — a close tag sitting
 * past the wall — terminates every scan successfully, so a failure-only memo
 * records nothing and the walk is quadratic all over again.
 */
function scanTagEnd(xml: string, from: number, known: Map<number, number>): number {
  let quote: '"' | "'" | null = null;
  const passedUnquoted: number[] = [];
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') {
      for (const p of passedUnquoted) known.set(p, i);
      return i;
    } else if (c === '<') passedUnquoted.push(i);
  }
  for (const p of passedUnquoted) known.set(p, -1);
  return -1;
}

/**
 * The `<name \u2026>\u2026</name>` and self-closing `<name \u2026/>` elements named by
 * `names`, in document order, treated as NON-NESTING (the first close tag
 * wins). The browser twin of the backend `ooxml-text.ts` scanner of the same
 * name, and it exists for the same reason: the patterns it replaces \u2014
 * `<a:p(?:\s[^>]*)?>([\s\S]*?)</a:p>` and its `a:t` twin \u2014 re-scanned the
 * rest of the slide part from EVERY opener whose match failed, so a crafted
 * deck of unmatched `<a:p>` openers cost O(openers x bytes). Measured on the
 * backend copy: a 391 KB wall of them took 19.4 s and QUADRUPLED with every
 * doubling. A viewer runs this on the user's own machine, in a tab that
 * cannot be closed while the main thread is pinned.
 *
 * Every way an opener can fail to become an element is bounded: an attribute
 * scan memoizes its answer for every opener it passed unquoted, whether it
 * ended at a `>` or ran off the end (see `scanTagEnd`), and a close tag is
 * looked for only when `lastIndexOf` says one still exists at or after the
 * search position \u2014 so a missing close tag costs one scan of the part in
 * total, not one per opener.
 */
export function xmlElementBlocks(xml: string, names: readonly string[]): XmlElementBlock[] {
  // Longest first, so a name that PREFIXES another can never shadow it.
  const wanted = [...names].sort((a, b) => b.length - a.length);
  const lastClose = new Map<string, number>();
  const lastCloseIndex = (name: string): number => {
    let known = lastClose.get(name);
    if (known === undefined) {
      known = xml.lastIndexOf(`</${name}>`);
      lastClose.set(name, known);
    }
    return known;
  };
  // `<` position → index of the `>` that ends the tag starting there, or -1
  // for "never terminates". Stays EMPTY on a well-formed part, where every
  // tag is scanned once and immediately consumed; it only fills under the
  // crafted shapes that used to make this walk quadratic. See `scanTagEnd`.
  const known = new Map<number, number>();
  const out: XmlElementBlock[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    // The delimiter check is what the regex's `(?:\s[^>]*)?>` alternation did:
    // it keeps `<a:pPr>` from counting as an `<a:p>`. `/` joins `\s` and `>`
    // here because a self-closing element IS one of the shapes we want.
    let name: string | undefined;
    for (const candidate of wanted) {
      if (
        xml.startsWith(candidate, lt + 1) &&
        NAME_DELIMITER.test(xml[lt + 1 + candidate.length] ?? '')
      ) {
        name = candidate;
        break;
      }
    }
    if (name === undefined) {
      i = lt + 1;
      continue;
    }
    const attrsStart = lt + 1 + name.length;
    // Only positions a PREVIOUS scan passed over need the memo: `lt` marches
    // forward, so the loop never asks about the same `<` twice and this scan's
    // own answer is never looked up again. The `known.size` guard keeps the
    // well-formed path to no hash lookup at all.
    const memo = known.size > 0 ? known.get(lt) : undefined;
    const gt = memo !== undefined ? memo : scanTagEnd(xml, attrsStart, known);
    if (gt === -1) {
      i = lt + 1; // unterminated tag: not an element
      continue;
    }
    // `<x a="/"/>` is self-closing, `<x a="/">` is not: the character before
    // the delimiter is only ever a `/` of the tag's own when it sits outside
    // every quote (a closing quote is `"` or `'`, never `/`).
    if (gt > attrsStart && xml[gt - 1] === '/') {
      out.push({ name, attrs: xml.slice(attrsStart, gt - 1), body: undefined });
      i = gt + 1;
      continue;
    }
    const bodyStart = gt + 1;
    if (bodyStart > lastCloseIndex(name)) {
      i = lt + 1; // no `</name>` left in the part \u2014 this opener cannot match
      continue;
    }
    const close = `</${name}>`;
    const closeAt = xml.indexOf(close, bodyStart);
    if (closeAt === -1) {
      i = lt + 1; // unreachable given the guard above; kept total
      continue;
    }
    out.push({ name, attrs: xml.slice(attrsStart, gt), body: xml.slice(bodyStart, closeAt) });
    i = closeAt + close.length;
  }
  return out;
}
