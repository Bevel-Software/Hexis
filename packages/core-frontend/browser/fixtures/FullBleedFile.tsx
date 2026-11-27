/**
 * A full-bleed file filling the window, as FileViewer draws it, over the real
 * surface classes and the real exit control. Mounted by
 * `full-bleed-full-screen.tsx` for `full-screen-exit-clearance.browser.ts`.
 *
 * The renderer is a stand-in with the PDF viewer's toolbar (`PdfRenderer`):
 * Prev, the page count, Next, a spacer, and Download at the right end, as an
 * outline `tiny` Button like `DownloadFileButton`'s. The real viewer needs
 * pdf.js and a byte source; what the test asks about is only where that row
 * lands against the exit control, which the toolbar's own classes decide.
 * The unit suites pin that the real PDF and XLSX toolbars carry
 * `FULL_SCREEN_EXIT_ROOM`.
 */
import { useRef } from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { Button } from '../../src/shared/components';
import {
  ExitFullScreenButton,
  FULL_BLEED_FULL_SCREEN_SURFACE,
} from '../../src/modules/workspace/components/FullScreenView';
import { FULL_SCREEN_EXIT_ROOM } from '../../src/modules/workspace/components/renderers/fullScreenExitRoom';

export function FullBleedFile() {
  const paneRef = useRef<HTMLDivElement>(null);
  return (
    // `data-full-screen`: the mark FileViewer puts on the read pane while it fills the window.
    <div ref={paneRef} data-pane="" data-full-screen="" className={FULL_BLEED_FULL_SCREEN_SURFACE}>
      <div className="flex h-full min-h-0 flex-col">
        <div
          data-toolbar=""
          className={`flex shrink-0 items-center gap-2 border-b border-line pb-2 ${FULL_SCREEN_EXIT_ROOM}`}
        >
          <Button variant="quiet" size="tiny" leadingIcon={<ChevronLeft size={13} />}>
            Prev
          </Button>
          <span className="text-detail text-ink-muted whitespace-nowrap">Page 1 of 3</span>
          <Button variant="quiet" size="tiny">
            Next
            <ChevronRight size={13} />
          </Button>
          <span className="flex-1" />
          <Button data-download="" variant="outline" size="tiny" leadingIcon={<Download size={12} />}>
            Download
          </Button>
        </div>
        <div className="min-h-0 flex-1" />
      </div>
      <ExitFullScreenButton onExit={() => {}} surface={paneRef} />
    </div>
  );
}
