import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { extractPptxOutline } from '../pptxOutline';

/**
 * The parser against real zips, built here from minimal slide XML — the same
 * fixtures a crafted-by-PowerPoint file reduces to. The conventions pinned
 * here are shared with the backend's `extract-pptx.ts`, so an agent's
 * `read_file` and this viewer describe the same deck the same way: numeric
 * slide order, runs joined with NO separator, entities decoded, notes
 * attached to their slide.
 */

/** One `<a:p>` paragraph whose `<a:t>` runs are exactly `runs`. */
function para(...runs: string[]): string {
  return `<a:p>${runs.map((r) => `<a:r><rPr b="1"/><a:t>${r}</a:t></a:r>`).join('')}</a:p>`;
}

function slideXml(...paragraphs: string[]): string {
  return `<?xml version="1.0"?><p:sld xmlns:a="urn:a" xmlns:p="urn:p"><p:cSld><p:spTree>${paragraphs.join('')}</p:spTree></p:cSld></p:sld>`;
}

async function zipBytes(entries: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('extractPptxOutline', () => {
  it('joins a paragraph\'s runs with no separator — PowerPoint splits them mid-word', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('Quart', 'erly ', 'results')),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides).toHaveLength(1);
    expect(slides[0].paragraphs).toEqual(['Quarterly results']);
  });

  it('decodes XML entities, named and numeric', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(
        para('R&amp;D &lt;2026&gt;'),
        para('&#65;&#x42; &quot;quoted&apos;'),
      ),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].paragraphs).toEqual(['R&D <2026>', 'AB "quoted\'']);
  });

  it('orders slides numerically by package number, not lexicographically', async () => {
    const bytes = await zipBytes({
      // Deliberately declared out of order, with a two-digit number that
      // sorts before "2" as a STRING.
      'ppt/slides/slide10.xml': slideXml(para('tenth')),
      'ppt/slides/slide2.xml': slideXml(para('second')),
      'ppt/slides/slide1.xml': slideXml(para('first')),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides.map((s) => s.number)).toEqual([1, 2, 10]);
    expect(slides.map((s) => s.paragraphs[0])).toEqual(['first', 'second', 'tenth']);
  });

  // No rels parts in this fixture — proves the numeric-name FALLBACK holds.
  it('attaches speaker notes to their slide by numeric name when no rels part exists', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('The pitch')),
      'ppt/slides/slide2.xml': slideXml(para('The ask')),
      'ppt/notesSlides/notesSlide2.xml': slideXml(para('pause here'), para('make eye contact')),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].notes).toEqual([]);
    expect(slides[1].notes).toEqual(['pause here', 'make eye contact']);
  });

  const RELS_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
  const NOTES_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';

  it('pairs notes through each slide\'s rels — the notes part number need not match the slide number', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('First')),
      'ppt/slides/slide2.xml': slideXml(para('Second')),
      // Notes for slide 2 live in a part numbered 7 — only the rels say so.
      'ppt/notesSlides/notesSlide7.xml': slideXml(para('note for slide two')),
      'ppt/slides/_rels/slide1.xml.rels': `<?xml version="1.0"?><Relationships ${RELS_NS}></Relationships>`,
      'ppt/slides/_rels/slide2.xml.rels':
        `<?xml version="1.0"?><Relationships ${RELS_NS}>` +
        `<Relationship Id="rId9" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide7.xml"/>` +
        '</Relationships>',
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].notes).toEqual([]);
    expect(slides[1].notes).toEqual(['note for slide two']);
  });

  it('a rels part WITHOUT a notesSlide relationship means no notes — the numeric twin is not guessed at', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('Solo')),
      'ppt/notesSlides/notesSlide1.xml': slideXml(para('orphan notes part')),
      'ppt/slides/_rels/slide1.xml.rels': `<?xml version="1.0"?><Relationships ${RELS_NS}></Relationships>`,
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].notes).toEqual([]);
  });

  it('rejects a deck whose slide part inflates past the 50 MB per-entry bound', async () => {
    const padded = slideXml(para('tiny text')) + ' '.repeat(51 * 1024 * 1024);
    const bytes = await zipBytes({ 'ppt/slides/slide1.xml': padded });
    await expect(extractPptxOutline(bytes)).rejects.toThrow(
      /could not be parsed as a \.pptx \(.*extraction bound/,
    );
  }, 30_000);

  it('drops empty paragraphs and keeps a text-free slide as an empty outline entry', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('kept'), '<a:p></a:p>', para('   ')),
      // A picture-only slide: present in the deck, so present in the outline.
      'ppt/slides/slide2.xml': slideXml(),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].paragraphs).toEqual(['kept']);
    expect(slides[1]).toEqual({ number: 2, paragraphs: [], notes: [] });
  });

  it('rejects bytes that are not a zip', async () => {
    const bytes = new TextEncoder().encode('this is not a zip archive').buffer as ArrayBuffer;
    await expect(extractPptxOutline(bytes)).rejects.toThrow(
      /could not be parsed as a \.pptx/,
    );
  });

  it('rejects a zip with no slides in it', async () => {
    const bytes = await zipBytes({ 'word/document.xml': '<w:document/>' });
    await expect(extractPptxOutline(bytes)).rejects.toThrow(
      /could not be parsed as a \.pptx \(no ppt\/slides/,
    );
  });

  it('pairs notes through a namespace-PREFIXED <r:Relationship> — prefixed rels must not drop notes', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('Deck')),
      'ppt/notesSlides/notesSlide4.xml': slideXml(para('prefixed note')),
      'ppt/slides/_rels/slide1.xml.rels':
        '<?xml version="1.0"?><r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<r:Relationship r:Id="rId2" r:Type="${NOTES_TYPE}" r:Target="../notesSlides/notesSlide4.xml"/>` +
        '</r:Relationships>',
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].notes).toEqual(['prefixed note']);
  });

  it('ignores a Target-looking sequence INSIDE another rels attribute value', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('Deck')),
      'ppt/notesSlides/notesSlide2.xml': slideXml(para('the real note')),
      'ppt/notesSlides/evil.xml': slideXml(para('decoy')),
      'ppt/slides/_rels/slide1.xml.rels':
        `<?xml version="1.0"?><Relationships ${RELS_NS}>` +
        `<Relationship Id="rId1" Comment="Target='../notesSlides/evil.xml'" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide2.xml"/>` +
        '</Relationships>',
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].notes).toEqual(['the real note']);
  });

  it('pairs notes through a NON-ASCII namespace prefix (full XML NCName) — \\w-only matching dropped these', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('Deck')),
      'ppt/notesSlides/notesSlide5.xml': slideXml(para('accented note')),
      'ppt/slides/_rels/slide1.xml.rels':
        '<?xml version="1.0"?><sé:Relationships xmlns:sé="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<sé:Relationship sé:Id="rId2" sé:Type="${NOTES_TYPE}" sé:Target="../notesSlides/notesSlide5.xml"/>` +
        '</sé:Relationships>',
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].notes).toEqual(['accented note']);
  });

  it('ignores xmlns:Type / xmlns:Target namespace DECLARATIONS on the Relationship element', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('Deck')),
      'ppt/notesSlides/notesSlide2.xml': slideXml(para('the real note')),
      'ppt/slides/_rels/slide1.xml.rels':
        '<?xml version="1.0"?><Relationships>' +
        `<Relationship xmlns:Target="http://ns.example/decl" Id="r1" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide2.xml"/>` +
        '</Relationships>',
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].notes).toEqual(['the real note']);
  });

  it('emits ONE slide per number — slide1.xml and slide01.xml must not become duplicate keys', async () => {
    const bytes = await zipBytes({
      // Declared canonical-first, so a zip-order tiebreak would pick the other
      // part than the rule below does.
      'ppt/slides/slide1.xml': slideXml(para('canonical one')),
      'ppt/slides/slide01.xml': slideXml(para('zero-padded twin')),
      'ppt/slides/slide2.xml': slideXml(para('two')),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides.map((s) => s.number)).toEqual([1, 2]);
    // The winner is the first in ascending PART-NAME order — `slide01.xml`
    // sorts before `slide1.xml` because '0' < '1'. Zip entry order is not a
    // contract, so the name is what decides, and the backend twin
    // (`extract-pptx.ts` `collectNumbered`) applies the identical rule: the
    // same deck must not read one way in the viewer and another through an
    // agent's `read_file`. The backend fixture for this parity lives in
    // core-backend's `doc-extract.test.ts`
    // ('extractPptx — two part names parsing to the SAME slide number'), and
    // asserts this same text.
    expect(slides[0].paragraphs).toEqual(['zero-padded twin']);
    expect(slides[1].paragraphs).toEqual(['two']);
  });

  it('follows the SELECTED part name to the rels — a zero-padded winner keeps its own notes', async () => {
    // The regression the dedup above introduced: the winner is chosen by
    // NAME, but the notes lookup rebuilt the rels path from the NUMBER. With
    // `slide01.xml` winning, `ppt/slides/_rels/slide1.xml.rels` is the LOSING
    // part's relationships — so slide 1 either lost its notes or was handed
    // the other file's. Same fixture as the backend twin's.
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('canonical one')),
      'ppt/slides/slide01.xml': slideXml(para('zero-padded twin')),
      'ppt/slides/_rels/slide01.xml.rels':
        `<?xml version="1.0"?><Relationships ${RELS_NS}>` +
        `<Relationship Id="rId1" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide01.xml"/>` +
        '</Relationships>',
      'ppt/notesSlides/notesSlide01.xml': slideXml(para('the padded twin speaks')),
      'ppt/slides/_rels/slide1.xml.rels':
        `<?xml version="1.0"?><Relationships ${RELS_NS}>` +
        `<Relationship Id="rId1" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide1.xml"/>` +
        '</Relationships>',
      'ppt/notesSlides/notesSlide1.xml': slideXml(para('notes of the part that LOST')),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides).toEqual([
      { number: 1, paragraphs: ['zero-padded twin'], notes: ['the padded twin speaks'] },
    ]);
  });

  it('and the no-rels fallback mirrors the name too — slide01.xml pairs with notesSlide01.xml', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide01.xml': slideXml(para('only slide')),
      'ppt/notesSlides/notesSlide01.xml': slideXml(para('padded notes')),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides).toEqual([{ number: 1, paragraphs: ['only slide'], notes: ['padded notes'] }]);
  });

  // Fix for the peak-memory restructure: parts are parsed as they are read
  // (per slide, then its notes) — the outline must be identical to the old
  // hold-everything-then-parse order for a deck mixing rels-paired notes,
  // numeric-fallback notes, and slides without notes.
  it('streams part-by-part and still yields the identical outline for a mixed deck', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide3.xml': slideXml(para('third')),
      'ppt/slides/slide1.xml': slideXml(para('first')),
      'ppt/slides/slide2.xml': slideXml(para('second')),
      // Slide 1: rels-paired notes in an oddly numbered part.
      'ppt/slides/_rels/slide1.xml.rels':
        `<?xml version="1.0"?><Relationships ${RELS_NS}>` +
        `<Relationship Id="rId9" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide8.xml"/>` +
        '</Relationships>',
      'ppt/notesSlides/notesSlide8.xml': slideXml(para('one note')),
      // Slide 2: numeric fallback (no rels part).
      'ppt/notesSlides/notesSlide2.xml': slideXml(para('two note')),
      // Slide 3: rels part naming no notes — the numeric twin must NOT attach.
      'ppt/slides/_rels/slide3.xml.rels': `<?xml version="1.0"?><Relationships ${RELS_NS}></Relationships>`,
      'ppt/notesSlides/notesSlide3.xml': slideXml(para('orphan')),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides).toEqual([
      { number: 1, paragraphs: ['first'], notes: ['one note'] },
      { number: 2, paragraphs: ['second'], notes: ['two note'] },
      { number: 3, paragraphs: ['third'], notes: [] },
    ]);
  });
  /**
   * The viewer carried the SAME quadratic the backend extractors did: the
   * `<a:p(?:\s[^>]*)?>([\s\S]*?)</a:p>` pattern re-scanned the rest of the
   * slide part from every opener whose close tag never came, so cost grew as
   * openers x bytes (measured on the backend twin: 391 KB took 19.4 s and
   * quadrupled per doubling). A deck is opened in the user's own tab, which
   * cannot be closed while the main thread is pinned.
   */
  it('a slide of 40k unmatched <a:p> openers still yields its real text, fast', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('Alive') + '<a:p algn="ctr">'.repeat(40_000)),
    });
    const t0 = performance.now();
    const slides = await extractPptxOutline(bytes);
    const ms = performance.now() - t0;
    expect(slides[0].paragraphs).toEqual(['Alive']);
    expect(ms).toBeLessThan(5_000);
  });

  // Every opener's attribute scan here reaches the `>` of the `</p:spTree>`
  // that sits PAST the wall, so each scan succeeds and a failure-only memo
  // records nothing — then the `lastIndexOf` guard rejects the opener anyway,
  // one full traversal at a time. Measured on this exact path before the memo
  // covered successes: 20k openers took 21.9 s.
  it('an unterminated attribute quote ends the scan instead of restarting per opener', async () => {
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(para('Alive') + '<a:p algn="never closed'.repeat(20_000)),
    });
    const t0 = performance.now();
    const slides = await extractPptxOutline(bytes);
    const ms = performance.now() - t0;
    expect(slides[0].paragraphs).toEqual(['Alive']);
    expect(ms).toBeLessThan(5_000);
  });

  it('reads a comment as text, so a commented paragraph neither outlines nor fills the memo', async () => {
    // A comment is WELL-FORMED xml and may hold anything, `<a:p ` included.
    // Read as markup it was wrong twice: the commented paragraph outlined as
    // if it were slide content, and its every `<` was charged to the tag memo
    // — so a deck with a big enough comment tripped the MAX_TAG_MEMO bound and
    // dropped every paragraph after it. The backend twin pins the same rule.
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml(
        `<!-- ${para('Ghost')}${'<a:p '.repeat(300_000)} -->${para('Alive')}`,
      ),
    });
    const t0 = performance.now();
    const slides = await extractPptxOutline(bytes);
    const ms = performance.now() - t0;
    expect(slides[0].paragraphs).toEqual(['Alive']);
    expect(ms).toBeLessThan(5_000);
  });

  it('CHANGED: a `>` inside a quoted attribute no longer leaks into the outline', async () => {
    // `[^>]*` stopped at the FIRST `>` even inside a quoted value, truncating
    // the tag: this run used to render as `q">Hi`. Quote-awareness fixes it,
    // and matches what the backend extractor now emits for the same deck.
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml('<a:p algn="a > b"><a:r><a:t x="p>q">Hi</a:t></a:r></a:p>'),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].paragraphs).toEqual(['Hi']);
  });

  it('a self-closing <a:p/> stays invisible — the outline drops blank paragraphs', async () => {
    // The scanner now reads `<a:p/>` as an EMPTY paragraph rather than no
    // paragraph at all; the outline filters blanks either way, so the viewer's
    // output is unchanged. Pinned so the parity with the backend (which DOES
    // keep the blank line, because a docx body preserves empty paragraphs) is
    // a decision on record rather than an accident.
    const bytes = await zipBytes({
      'ppt/slides/slide1.xml': slideXml('<a:p/>' + para('kept') + '<a:p style="s"/>'),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides[0].paragraphs).toEqual(['kept']);
  });
});
