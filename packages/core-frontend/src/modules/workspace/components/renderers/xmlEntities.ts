/**
 * Dependency-free XML/HTML text-scanning primitives shared by the document
 * renderers — the browser twin of the backend's `ooxml-text.ts` fragments.
 *
 * Deliberately import-free: `emailMessage.ts` (the email viewer's model) and
 * `pptxOutline.ts` (which pulls in JSZip) both need these, and sharing them
 * THROUGH `pptxOutline.ts` made the email chunk evaluate — and bundle —
 * presentation code it never uses.
 */

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

/**
 * Regex FRAGMENT for a tag's attribute region that never mistakes a `/>` (or
 * `>`) INSIDE a quoted attribute value for the tag's delimiter: the region is
 * consumed as either single non-quote characters or WHOLE quoted spans, so a
 * lazy expansion can only stop at a delimiter that sits outside every quote.
 * No capture groups — wrap in `(…)` at the use site when the attrs are needed.
 */
export const TAG_ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*?`;

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
