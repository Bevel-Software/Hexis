/**
 * The file page's prose view, reduced to what the full-screen switch moves:
 * the shell that scrolls the page, the read pane, and the document's card —
 * the REAL `FilePaneCard`, under the REAL column constants and the REAL
 * carry (`readingCarry.ts`), laid out by a real browser. Mounted by
 * `full-screen-reading.tsx` into the page `full-screen-reading-width.browser.ts`
 * builds; nothing here stands in for the pieces under test, only for the
 * file page around them (its header, its router, its renderers), which the
 * switch does not touch.
 *
 * The enter / leave sequence is the file viewer's, step for step: measure
 * the reader's place and the card's width, flip the view, carry the place
 * once the new layout is in. It is restated here rather than imported
 * because the viewer's lives inside a component the page cannot mount alone.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { FilePaneCard } from '../../src/modules/workspace/components/FilePaneCard';
import { FULL_SCREEN_SURFACE } from '../../src/modules/workspace/components/FullScreenView';
import {
  carryReadingOffset,
  readingAnchorIn,
  readingOffset,
  readingWidthOf,
} from '../../src/modules/workspace/components/readingCarry';
import { DOCUMENT_COLUMN, DOCUMENT_COLUMN_CONTENT, documentSideGutters } from '../../src/shared/theme/measure';

declare global {
  interface Window {
    /** The test's controls over the mounted page (`full-screen-reading.tsx` mounts; the view answers). */
    reading: {
      /** Mount the page afresh: on the page, or already filling the window as a `?fullscreen=1` link opens. */
      mount(opts?: { filling?: boolean }): void;
      enter(): void;
      leave(): void;
      filling(): boolean;
    };
  }
}

const SECTIONS = 12;
const PARAGRAPHS_PER_SECTION = 5;

/** Varied prose, so the wrap of every paragraph depends on the width. */
function paragraph(section: number, index: number): string {
  const words = [
    'knowledge', 'change', 'request', 'approve', 'branch', 'the', 'a', 'reader', 'carries', 'section',
    'width', 'column', 'line', 'wraps', 'exactly', 'where', 'it', 'did', 'before', 'full', 'screen',
  ];
  const out: string[] = [];
  const length = 40 + ((section * 7 + index * 13) % 60);
  for (let i = 0; i < length; i += 1) out.push(words[(i * (section + 2) + index * 3) % words.length]!);
  return `${out.join(' ')}.`;
}

export function Reading({ initialFilling }: { initialFilling: boolean }) {
  const [filling, setFilling] = useState(initialFilling);
  const [readingWidth, setReadingWidth] = useState<number | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const readingOffsetRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const offset = readingOffsetRef.current;
    readingOffsetRef.current = null;
    const scroller = filling ? paneRef.current : shellRef.current;
    const anchor = readingAnchorIn(paneRef.current);
    if (offset === null || !scroller || !anchor) return;
    carryReadingOffset(scroller, anchor, offset);
  }, [filling]);

  useLayoutEffect(() => {
    window.reading.enter = () => {
      const shell = shellRef.current;
      const anchor = readingAnchorIn(paneRef.current);
      if (shell && anchor) {
        readingOffsetRef.current = readingOffset(shell, anchor);
        setReadingWidth(readingWidthOf(anchor));
      }
      setFilling(true);
    };
    window.reading.leave = () => {
      const pane = paneRef.current;
      const anchor = readingAnchorIn(paneRef.current);
      if (pane && anchor) readingOffsetRef.current = readingOffset(pane, anchor);
      setReadingWidth(null);
      setFilling(false);
    };
    window.reading.filling = () => filling;
  }, [filling]);

  return (
    <div ref={shellRef} data-shell="" className="h-screen overflow-auto bg-canvas">
      <div className={`${DOCUMENT_COLUMN} ${documentSideGutters(false)} py-10`}>
        <div
          ref={paneRef}
          data-pane=""
          className={filling ? `${FULL_SCREEN_SURFACE} ${documentSideGutters(false)} py-10` : 'min-w-0'}
        >
          <FilePaneCard
            file="Long.md"
            chromeless={filling}
            className={filling ? DOCUMENT_COLUMN_CONTENT : undefined}
            style={filling && readingWidth !== null ? { maxWidth: readingWidth } : undefined}
          >
            {Array.from({ length: SECTIONS }, (_, s) => (
              <section key={s} data-section={s + 1}>
                <h2 className="mt-6 mb-2 text-lg font-semibold">Section {s + 1}</h2>
                {Array.from({ length: PARAGRAPHS_PER_SECTION }, (_, p) => (
                  <p key={p} data-paragraph={s * PARAGRAPHS_PER_SECTION + p + 1} className="my-3 text-[15px] leading-6">
                    {paragraph(s + 1, p + 1)}
                  </p>
                ))}
              </section>
            ))}
          </FilePaneCard>
        </div>
      </div>
    </div>
  );
}
