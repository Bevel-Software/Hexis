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
  /**
   * The `header` slot's whole contract, in one assertion per variant: the
   * band opens the column, whatever else the page puts in it.
   *
   * It is a slot rather than the caller's first child because a caller
   * forgot — `FileViewer` rendered the tab strip above its title bar and put
   * the file page's band 54px below the sidebar header row it lines up with.
   * What that costs, and the offset each variant opens on, is asserted at the
   * seam in `layout/__tests__/HeaderAlignment.test.tsx`; that the file page
   * really uses the slot is asserted in `FileViewer.test.tsx`.
   */
  it.each([
    ['prose', {}],
    ['full-bleed', { variant: 'full-bleed' as const }],
    ['panel', { variant: 'panel' as const }],
    ['with a rail', { rail: <p>About this file</p> }],
  ])('puts the header first in the column (%s)', (_name, props) => {
    render(
      <KbDocumentShell {...props} header={<h1>The title bar</h1>}>
        <div>Everything else the page renders</div>
      </KbDocumentShell>,
    );
    const band = screen.getByText('The title bar');
    const content = screen.getByText('Everything else the page renders');

    // IN the column, not above it. "First" on its own is satisfied by a band
    // hoisted into a wrapper of its own — which is the regression that
    // reaches the seam, because a wrapper outside the column does not carry
    // the column's `HEADER_COLUMN_TOP` and can put anything underneath it.
    // Tying the band to the content is what makes the next two lines mean
    // "opens the column" rather than "opens something".
    expect(band.parentElement).toBe(content.parentElement);
    expect(band.previousElementSibling).toBeNull();
    expect(band.nextElementSibling).toBe(content);

    // And the column is inside the shell's own scrolling box in every
    // variant, so nothing can render between the two.
    expect(screen.getByTestId('kb-document-shell')).toContainElement(band);
  });

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

  /**
   * `panel` is the reading view's COLUMN with full-bleed's HEIGHT — the one
   * variant that has to agree with another one, so it is asserted against the
   * prose column rather than against a list of classes copied out of
   * `measure.ts`.
   *
   * The file page's history and comparison modes use it. They are viewports
   * the way a PDF is, and they took 'full-bleed' for that reason; what they
   * are not is a renderer the document makes room for. They stand IN the
   * document's place, so the column has to stay exactly where the document
   * left it, which is what this compares.
   */
  it('gives a panel the prose column, minus the rhythm a document ends on', () => {
    const frameOf = (text: string) => (screen.getByText(text).parentElement as HTMLElement).className;

    const prose = render(
      <KbDocumentShell roomy>
        <p>The document</p>
      </KbDocumentShell>,
    );
    const reading = frameOf('The document');
    prose.unmount();

    render(
      <KbDocumentShell variant="panel" roomy>
        <p>The log</p>
      </KbDocumentShell>,
    );
    const panel = frameOf('The log');

    // The measure, the margins and the offset the band opens on: identical,
    // and read off the reading view rather than restated.
    for (const cls of ['mx-auto', 'max-w-[880px]', 'px-[64px]', 'max-[900px]:px-[18px]', 'pt-3']) {
      expect(reading).toContain(cls);
      expect(panel).toContain(cls);
    }
    // `roomy` reaches it too, or a panel would keep the nav's margins on a
    // page that has hidden the nav.
    expect(panel).not.toContain('px-[40px]');

    // A definite height instead of the bottom rhythm — a column that ends
    // where the pane does has nothing to leave room after.
    expect(panel).toContain('h-full');
    expect(panel).not.toContain('pb-[110px]');
    expect(reading).toContain('pb-[110px]');
  });

  // The regression this file exists for. `editorContainerRef` carries a
  // capture-phase scroll listener that is the file lock's ONLY activity signal
  // for someone who is reading rather than typing. Scroll events do not
  // bubble, so a ref on an element nested inside the scroller never fires —
  // and nothing type-errors when that happens; locks just silently drop out
  // from under readers after two minutes.
  it.each(['prose', 'full-bleed', 'panel'] as const)(
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
