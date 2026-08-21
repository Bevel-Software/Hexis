import { describe, it, expect } from 'vitest';
import { decodeXmlEntities, xmlElementBlocks } from '../xmlEntities';

/**
 * The dependency-free decoder both browser readers lean on (the pptx outline
 * and the email body strip). Its twin is the backend's `ooxml-text.ts`, tested
 * in `doc-extract.test.ts` — the two must agree character for character, or a
 * viewer and an agent's `read_file` describe the same document differently.
 */
describe('decodeXmlEntities', () => {
  it('decodes the five named entities and well-formed numeric references', () => {
    expect(decodeXmlEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
    expect(decodeXmlEntities('&#65;&#x41;&#x1F600;')).toBe('AA\u{1F600}');
  });

  it('leaves a MALFORMED reference literal instead of inventing a character', () => {
    // `&#12A;` is not a reference. The old pattern accepted hex digits after a
    // bare `#` and then parsed them as DECIMAL — parseInt('12A', 10) stops at
    // the 'A' and yields 12, so the text silently became U+000C.
    expect(decodeXmlEntities('&#12A;')).toBe('&#12A;');
    expect(decodeXmlEntities('price &#12A; each')).toBe('price &#12A; each');
    expect(decodeXmlEntities('&#;')).toBe('&#;');
    expect(decodeXmlEntities('&#xZZ;')).toBe('&#xZZ;');
  });

  it('follows XML, not HTML, on the hex marker: `&#X41;` is not a reference', () => {
    // XML 1.0 §4.1 spells the marker lowercase `x` only; HTML5 also accepts
    // `X`. The strict reading wins, so a capital X stays literal rather than
    // being read as an unrelated decimal.
    expect(decodeXmlEntities('&#X41;')).toBe('&#X41;');
  });

  it('leaves an out-of-range code point literal rather than throwing', () => {
    expect(decodeXmlEntities('&#1114112;')).toBe('&#1114112;'); // 0x110000
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;');
  });

  it('leaves an unknown named entity alone', () => {
    expect(decodeXmlEntities('&nbsp;&copy;')).toBe('&nbsp;&copy;');
  });
});

/**
 * The shared element scanner, browser copy. Its twin lives in the backend's
 * `ooxml-text.ts` and is tested in core-backend's `doc-extract.test.ts`
 * against the same shapes; the two must agree, or a deck reads one way in the
 * viewer and another through an agent's `read_file`.
 */
describe('xmlElementBlocks', () => {
  const bodies = (xml: string, name: string): Array<string | undefined> =>
    xmlElementBlocks(xml, [name]).map((e) => e.body);

  it('reads the ordinary shapes: open/close, self-closing, quoted `>` and `/`', () => {
    expect(bodies('<a:p>body</a:p>', 'a:p')).toEqual(['body']);
    expect(bodies('<a:p/>', 'a:p')).toEqual([undefined]);
    expect(bodies('<a:p algn="a > b">body</a:p>', 'a:p')).toEqual(['body']);
    expect(bodies('<a:p algn="a/>b"/>', 'a:p')).toEqual([undefined]);
    expect(bodies('<a:pPr>props</a:pPr>', 'a:p')).toEqual([]);
  });

  it('a `/` that is not the `/` of `/>` does NOT end the element name', () => {
    // XML lets exactly three things follow a name: whitespace, `>`, or `/>`.
    // Admitting a bare `/` made `<a:p/x>` an OPENER, so everything up to the
    // next `</a:p>` was rendered as that paragraph's text — a malformed tag
    // handing the viewer text the deck never contained.
    expect(bodies('<a:p/x>leaked</a:p>', 'a:p')).toEqual([]);
    expect(bodies('<a:t/x>leaked</a:t><a:t>kept</a:t>', 'a:t')).toEqual(['kept']);
  });

  it('gives the part up once the tag-end memo fills, rather than allocating past it', () => {
    // The memo is what keeps this walk linear, but it costs an entry per `<`
    // a tag scan passes outside quotes — and only MALFORMED xml puts a `<`
    // there, so on a real part it stays empty. A crafted one is another
    // matter: measured on a 50 MB wall of `<a:p ` openers, the memo alone
    // allocated 1170 MB (23x the part it describes) over 6.8 s — in the
    // user's own tab. Bounded, the same input costs 2.6 MB and 5 ms, flat
    // from 15 MB of input to 50 MB. Elements found BEFORE the cap survive;
    // the tail is abandoned, because evicting or memoizing no further would
    // hand back the quadratic the memo exists to prevent.
    const xml = '<a:p>first</a:p>' + '<a:p '.repeat(300_000) + '<a:p>last</a:p>';
    const t0 = performance.now();
    const found = bodies(xml, 'a:p');
    const ms = performance.now() - t0;
    expect(found).toEqual(['first']);
    expect(ms).toBeLessThan(5_000);
  });

  it('an attribute quote that never closes still costs two traversals, not one per opener', () => {
    // A `<` met INSIDE an unterminated quote is recorded by nobody — but the
    // first scan that BEGINS outside the quote walks that same tail in the
    // no-quote state and records every one of them, so the wall costs two
    // traversals in total rather than one apiece.
    const xml = '<a:p>kept</a:p><a:p algn="' + '<a:p '.repeat(40_000);
    const t0 = performance.now();
    const found = bodies(xml, 'a:p');
    const ms = performance.now() - t0;
    expect(found).toEqual(['kept']);
    expect(ms).toBeLessThan(5_000);
  });
});
