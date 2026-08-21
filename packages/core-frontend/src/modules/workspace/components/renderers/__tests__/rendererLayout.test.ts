import { describe, it, expect } from 'vitest';
import { getRendererLayout, isBinaryFile, isViewOnlyFile } from '../index';

/**
 * The layout choice is the one thing in WP1 that cannot fail loudly: pick
 * `prose` for a PDF and the `h-full` iframe collapses to zero height in an
 * auto-height column, with no type error and no console warning. So the map is
 * pinned here, extension by extension.
 */
describe('getRendererLayout', () => {
  it.each([
    'Knowledge/Foo.md',
    'Knowledge/notes.txt',
    'Knowledge/report.docx',
    'Knowledge/no-extension-file',
    // The pptx outline view is a text document, not a viewport.
    'Inbox/all-hands.pptx',
    // The legacy-format / ODF no-preview note is one paragraph on the prose
    // measure.
    'old/memo.doc',
    'old/deck.ppt',
    'old/sheet.xls',
    'docs/spec.odt',
    'decks/pitch.odp',
    'data/numbers.ods',
    // An email is a letter: headers + a text body on the prose measure.
    'Inbox/offer.eml',
    'Inbox/thread.msg',
  ])('lays out %s as a document', (path) => {
    expect(getRendererLayout(path)).toBe('prose');
  });

  it.each([
    'Inbox/brief.pdf',
    'Inbox/diagram.png',
    'Inbox/photo.JPG',
    'Data/velocity.csv',
    'Data/book.xlsx',
    'Knowledge/page.html',
    'Tools/search.tool',
  ])('lays out %s as a viewport of its own', (path) => {
    expect(getRendererLayout(path)).toBe('full-bleed');
  });
});

/**
 * Deliberately NOT the same set as the layout map — a CSV is laid out
 * full-bleed and is still text you can count. Conflating the two would make
 * the rail print a character count for a PDF, which is a number nobody can
 * interpret.
 */
describe('isBinaryFile', () => {
  it.each([
    'Inbox/brief.pdf',
    'Inbox/diagram.png',
    'Inbox/report.docx',
    'Data/book.xlsx',
    'Inbox/all-hands.pptx',
    'old/memo.doc',
    'old/deck.ppt',
    'old/sheet.xls',
    'docs/spec.odt',
    'decks/pitch.odp',
    'data/numbers.ods',
    // .msg is binary CFB; .eml is the .svg case — its bytes are text, but the
    // viewer fetches raw bytes and parses the MIME, so the text buffer a
    // character count would describe is never shown.
    'Inbox/thread.msg',
    'Inbox/offer.eml',
  ])('knows %s holds no countable text', (path) => {
    expect(isBinaryFile(path)).toBe(true);
  });

  // The one file whose bytes ARE text and still must not be counted: it goes
  // to `ImageRenderer` as a picture, so the character count would describe a
  // buffer nobody was shown.
  it.each(['Diagrams/flow.svg', 'Diagrams/LOGO.SVG'])(
    'treats %s as an image payload, not countable text',
    (path) => {
      expect(isBinaryFile(path)).toBe(true);
      expect(getRendererLayout(path)).toBe('full-bleed');
    },
  );

  it.each(['Knowledge/Foo.md', 'Data/velocity.csv', 'Knowledge/page.html', 'Knowledge/notes.txt'])(
    'knows %s is text',
    (path) => {
      expect(isBinaryFile(path)).toBe(false);
    },
  );
});

/**
 * View-only routes render a no-preview note — there is no editing surface, so
 * the page's write action (Edit / Propose) must not be offered for them.
 */
describe('isViewOnlyFile', () => {
  it.each([
    'old/memo.doc',
    'old/deck.ppt',
    'old/sheet.xls',
    'docs/spec.odt',
    'decks/pitch.odp',
    'data/numbers.ods',
    'docs/SPEC.ODT',
    // A message snapshot has no editing surface either.
    'Inbox/offer.eml',
    'Inbox/thread.msg',
    'Inbox/OFFER.EML',
  ])('marks %s view-only', (path) => {
    expect(isViewOnlyFile(path)).toBe(true);
  });

  it.each(['Knowledge/Foo.md', 'Inbox/report.docx', 'Inbox/brief.pdf', 'Data/velocity.csv'])(
    'leaves %s with its write action',
    (path) => {
      expect(isViewOnlyFile(path)).toBe(false);
    },
  );
});
