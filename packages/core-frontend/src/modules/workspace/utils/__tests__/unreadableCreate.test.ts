import { describe, it, expect } from 'vitest';
import {
  directChildNames,
  folderLabel,
  isMarkdownName,
  unreadableAmong,
  unreadableCreateSentence,
  unreadableNames,
} from '../unreadableCreate';

/** A `File` is only ever read for its name here. */
const file = (name: string) => new File([''], name);
/** Just enough of a `FileSystemEntry` for the walker-shaped input. */
const entry = (name: string, isFile: boolean): FileSystemEntry =>
  ({ name, isFile, isDirectory: !isFile }) as FileSystemEntry;

describe('which names would land invisible', () => {
  it('exempts markdown — it carries the creator grant in its own frontmatter', () => {
    expect(isMarkdownName('Notes.md')).toBe(true);
    expect(isMarkdownName('NOTES.MD')).toBe(true);
    expect(isMarkdownName('Sample file')).toBe(false);
    expect(isMarkdownName('brief.pdf')).toBe(false);
    // Not a markdown file — the extension is the whole name's tail.
    expect(isMarkdownName('md')).toBe(false);
    expect(unreadableAmong(['a.md', 'b.pdf', 'Sample file'])).toEqual(['b.pdf', 'Sample file']);
  });

  it('counts only what lands DIRECTLY in the target folder', () => {
    // A picked folder's files all sit under a new directory, whose own
    // access.md carries the grant — nothing there can go missing.
    expect(
      unreadableNames({
        kind: 'paths',
        items: [
          { file: file('a.pdf'), relativePath: 'deck/a.pdf' },
          { file: file('b.pdf'), relativePath: 'deck/sub/b.pdf' },
        ],
      }),
    ).toEqual([]);
    expect(
      unreadableNames({
        kind: 'paths',
        items: [
          { file: file('loose.pdf'), relativePath: 'loose.pdf' },
          { file: file('a.pdf'), relativePath: 'deck/a.pdf' },
        ],
      }),
    ).toEqual(['loose.pdf']);
  });

  it('reads a dropped folder entry as a new directory, never as an affected name', () => {
    expect(
      unreadableNames({
        kind: 'items',
        entries: [entry('deck', false), entry('brief.pdf', true), entry('note.md', true)],
      }),
    ).toEqual(['brief.pdf']);
  });

  it('never warns about OS noise the upload drops anyway', () => {
    expect(directChildNames({ kind: 'files', files: [file('.DS_Store'), file('a.pdf')] })).toEqual([
      'a.pdf',
    ]);
    expect(
      directChildNames({
        kind: 'paths',
        items: [{ file: file('.DS_Store'), relativePath: '.DS_Store' }],
      }),
    ).toEqual([]);
  });
});

describe('what the dialog says', () => {
  it('names the file and the folder, as the ticket writes it', () => {
    expect(unreadableCreateSentence(['Sample file'], '')).toBe(
      "You won't be able to see Sample file after it is added: you don't have read access to the top level.",
    );
    expect(unreadableCreateSentence(['brief.pdf'], 'Sales')).toBe(
      "You won't be able to see brief.pdf after it is added: you don't have read access to Sales.",
    );
  });

  it('counts a batch instead of running every name into the sentence', () => {
    expect(unreadableCreateSentence(['a.pdf', 'b.pdf', 'c.pdf'], 'Sales')).toBe(
      "You won't be able to see these 3 files after they are added: you don't have read access to Sales.",
    );
  });

  it('calls the repository root what the move confirmation calls it', () => {
    expect(folderLabel('')).toBe('the top level');
    expect(folderLabel('Sales/2026')).toBe('Sales/2026');
  });
});
