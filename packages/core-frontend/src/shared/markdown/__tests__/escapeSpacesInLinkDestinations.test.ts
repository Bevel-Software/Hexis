import { describe, it, expect } from 'vitest';
import { escapeSpacesInLinkDestinations } from '../Markdown';

/**
 * The pre-parse that lets a KB link or image reach a file whose name has
 * spaces in it. Every KB markdown surface runs it, so what it does to a
 * destination is what the reader gets.
 */
describe('escapeSpacesInLinkDestinations', () => {
  it('wraps a destination with spaces in angle brackets, for links and images alike', () => {
    expect(escapeSpacesInLinkDestinations('[Foo](Some File.md)')).toBe('[Foo](<Some File.md>)');
    expect(escapeSpacesInLinkDestinations('![Shot](./assets/Approval screen.png)')).toBe(
      '![Shot](<./assets/Approval screen.png>)',
    );
  });

  it('leaves a destination without spaces, or one already wrapped, alone', () => {
    expect(escapeSpacesInLinkDestinations('[Foo](Some-File.md)')).toBe('[Foo](Some-File.md)');
    expect(escapeSpacesInLinkDestinations('[Foo](<Some File.md>)')).toBe('[Foo](<Some File.md>)');
  });

  // A title is the one place a space is legal in a destination. Wrapping the
  // whole tail (`<path "title">`) used to make the title part of the path and
  // lose it as a title; the path is what gets wrapped, the title stays outside.
  it('wraps only the path of a titled destination and keeps the title', () => {
    expect(escapeSpacesInLinkDestinations('![Shot](./assets/Approval screen.png "The approval screen")')).toBe(
      '![Shot](<./assets/Approval screen.png> "The approval screen")',
    );
    expect(escapeSpacesInLinkDestinations("[Foo](Some File.md 'A note')")).toBe(
      "[Foo](<Some File.md> 'A note')",
    );
  });

  it('does not wrap a plain path just because its title has spaces', () => {
    expect(escapeSpacesInLinkDestinations('![Shot](./assets/shot.png "The approval screen")')).toBe(
      '![Shot](./assets/shot.png "The approval screen")',
    );
  });
});
