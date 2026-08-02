import { describe, it, expect } from 'vitest';
import { getRendererLayout } from '../index';

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
