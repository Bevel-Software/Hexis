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
      'ppt/slides/slide1.xml': slideXml(para('canonical one')),
      'ppt/slides/slide01.xml': slideXml(para('zero-padded twin')),
      'ppt/slides/slide2.xml': slideXml(para('two')),
    });
    const slides = await extractPptxOutline(bytes);
    expect(slides.map((s) => s.number)).toEqual([1, 2]);
    // First occurrence wins: the canonical part was seen first.
    expect(slides[0].paragraphs).toEqual(['canonical one']);
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
});
