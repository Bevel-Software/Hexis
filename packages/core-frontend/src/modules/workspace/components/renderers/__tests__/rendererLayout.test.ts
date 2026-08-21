import { describe, it, expect } from 'vitest';
import { getRendererLayout, isBinaryFile } from '../index';

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
    // The legacy-format note is one paragraph on the prose measure.
    'old/memo.doc',
    'old/deck.ppt',
    'old/sheet.xls',
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
