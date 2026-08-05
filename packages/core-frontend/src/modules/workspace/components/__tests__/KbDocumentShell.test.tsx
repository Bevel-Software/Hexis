import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { KbDocumentShell } from '../KbDocumentShell';

/**
 * The shell's job is a measure and a scroll contract. Both are invisible to a
 * headless DOM's layout engine, so these tests assert the STRUCTURE that
 * produces them — which track the children land in, and which node the ref
 * lands on — rather than computed pixels.
 */
describe('KbDocumentShell', () => {
  it('renders children inside a centred, measured column', () => {
    render(
      <KbDocumentShell>
        <p>The document</p>
      </KbDocumentShell>,
    );
    const column = screen.getByText('The document').parentElement!;
    expect(column.className).toContain('mx-auto');
    expect(column.className).toContain('max-w-[880px]');
  });

  it('opens a second track and widens the measure when a rail is given', () => {
    render(
      <KbDocumentShell rail={<p>About this file</p>}>
        <p>The document</p>
      </KbDocumentShell>,
    );

    expect(screen.getByText('About this file')).toBeInTheDocument();
    // The article and the rail are siblings in one grid, not nested.
    const article = screen.getByText('The document').closest('article')!;
    const aside = screen.getByText('About this file').closest('aside')!;
    expect(article.parentElement).toBe(aside.parentElement);
    expect(article.parentElement!.className).toContain('max-w-[980px]');
    expect(article.parentElement!.className).toContain('grid');
  });

  it('uses one narrow track when there is no rail', () => {
    const { container } = render(
      <KbDocumentShell>
        <p>The document</p>
      </KbDocumentShell>,
    );
    expect(container.querySelector('aside')).toBeNull();
    expect(screen.getByText('The document').parentElement!.className).not.toContain('grid');
  });

  it('drops the measure and the bottom rhythm in full-bleed', () => {
    render(
      <KbDocumentShell variant="full-bleed">
        <p>A PDF</p>
      </KbDocumentShell>,
    );
    const box = screen.getByText('A PDF').parentElement!;
    expect(box.className).not.toContain('max-w-[880px]');
    expect(box.className).not.toContain('pb-[110px]');
    // A definite height instead, so an `h-full` iframe inside gets real pixels.
    expect(box.className).toContain('h-full');
  });

  // The regression this file exists for. `editorContainerRef` carries a
  // capture-phase scroll listener that is the file lock's ONLY activity signal
  // for someone who is reading rather than typing. Scroll events do not
  // bubble, so a ref on an element nested inside the scroller never fires —
  // and nothing type-errors when that happens; locks just silently drop out
  // from under readers after two minutes.
  it.each(['prose', 'full-bleed'] as const)(
    'lands scrollRef on the element that scrolls (%s)',
    (variant) => {
      const ref = createRef<HTMLDivElement>();
      render(
        <KbDocumentShell variant={variant} scrollRef={ref}>
          <p>Body</p>
        </KbDocumentShell>,
      );
      expect(ref.current).toBe(screen.getByTestId('kb-document-shell'));
      expect(ref.current!.className).toContain('overflow-auto');
      // And the body really is a descendant of it, so capture reaches the ref.
      expect(ref.current!.contains(screen.getByText('Body'))).toBe(true);
    },
  );
});
