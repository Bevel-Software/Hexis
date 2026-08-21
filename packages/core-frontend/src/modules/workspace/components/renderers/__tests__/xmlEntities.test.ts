import { describe, it, expect } from 'vitest';
import { decodeXmlEntities } from '../xmlEntities';

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
