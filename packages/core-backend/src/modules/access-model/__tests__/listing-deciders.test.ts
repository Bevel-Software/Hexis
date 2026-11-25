import { describe, it, expect } from 'vitest';
import { decidesListing, fencedHead, listingUnchangedBy } from '../index.js';

describe('which files decide what a listing shows', () => {
  it.each([
    ['access.md', true],
    ['Data/Sales/access.md', true],
    ['roles.yaml', true],
    ['groups.yaml', true],
    ['synced-groups.yaml', true],
    ['.bevelignore', true],
    ['Data/Big/.bevelignore', true],
    ['Plugins/sales/plugin.json', true],
    ['Plugins/sales/skills/call/plugin.json', true],
    // The same names where they decide nothing.
    ['Data/roles.yaml', false],
    ['Data/groups.yaml', false],
    ['Data/plugin.json', false],
    ['Data/Sales/Customer.md', false],
    ['Data/Sales/my-access.md', false],
    ['Plugins/sales/skills/call/SKILL.md', false],
  ])('%s: %s', (p, expected) => {
    expect(decidesListing(p, 'Plugins')).toBe(expected);
  });
});

describe('a commit that left every listing as it was', () => {
  it('is an edit of an ordinary file whose frontmatter stayed the same', () => {
    expect(listingUnchangedBy({ frontmatterChanged: false }, 'Data/Sales/Customer.md', 'Plugins')).toBe(true);
  });
  it('is not one whose frontmatter changed', () => {
    expect(listingUnchangedBy({ frontmatterChanged: true }, 'Data/Sales/Customer.md', 'Plugins')).toBe(false);
  });
  it('is not an edit of a file that decides a listing', () => {
    expect(listingUnchangedBy({ frontmatterChanged: false }, 'Data/Sales/access.md', 'Plugins')).toBe(false);
  });
  it('is not a commit of another kind, or one whose kind is not known', () => {
    expect(listingUnchangedBy(undefined, 'Data/Sales/Customer.md', 'Plugins')).toBe(false);
  });
});

describe('the leading fenced block of a text', () => {
  it('is the block, whatever follows it', () => {
    expect(fencedHead('---\nread: [A]\n---\nbody one')).toBe(fencedHead('---\nread: [A]\n---\nbody two'));
  });
  it('differs when an entry in it differs', () => {
    expect(fencedHead('---\nread: [A]\n---\nbody')).not.toBe(fencedHead('---\nread: [B]\n---\nbody'));
  });
  it('is the same for either kind of line end', () => {
    expect(fencedHead('---\r\nread: [A]\r\n---\r\nbody')).toBe(fencedHead('---\nread: [A]\n---\nbody'));
  });
  // The fence rule is the platform's, the one the access grammar reads a file
  // by: a fence padded with spaces opens a block too, so an entry changed in
  // such a block must show as a changed head.
  it.each(['--- \nread: [X]\n--- \nbody', '---\t\nread: [X]\n---\nbody', '---\r\nread: [X]\r\n---  \r\nbody'])(
    'sees a changed entry behind a padded fence: %j',
    (text) => {
      expect(fencedHead(text.replace('[X]', '[A]'))).not.toBe(fencedHead(text.replace('[X]', '[B]')));
      expect(fencedHead(text.replace('[X]', '[A]'))).not.toBe('');
    },
  );
  it('is empty for a text that does not open with one', () => {
    expect(fencedHead('# Name\n---\nread: [A]\n---\n')).toBe('');
  });
  it('is the whole text when the block is never closed, so any edit counts', () => {
    expect(fencedHead('---\nname: tool\nurl: a\n')).not.toBe(fencedHead('---\nname: tool\nurl: b\n'));
  });
});
