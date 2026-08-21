import { useEffect, useState } from 'react';
import { Presentation } from 'lucide-react';
import { useWorkspace } from '../../state/workspace.context';
import { authFetch } from '../../../../lib/api';
import { DownloadFileButton } from './DownloadFileButton';
import { extractPptxOutline, type PptxSlide } from './pptxOutline';
import type { FileRendererProps } from './types';

/**
 * The honest `.pptx` view: a text outline, not a slide facsimile.
 *
 * Browser-side pptx RENDERERS were evaluated and rejected — every available
 * one draws a wrong-enough version of the deck (fonts substituted, SmartArt
 * and charts dropped, positioning approximate) that the result misleads more
 * than it informs. So this viewer does what the backend's text extractor does
 * for agents: slides as sections, each paragraph a line, speaker notes
 * attached — and says so, with the original file one click away. The outline
 * IS the same story `read_file` tells an agent about this deck (see
 * `pptxOutline.ts`), which keeps human and agent conversations about "slide
 * 4" pointing at the same thing.
 *
 * Text only, rendered as React text nodes — nothing from the document is ever
 * interpreted as HTML, so there is no sanitization question here.
 *
 * View-only: there is no edit mode for binary office formats. The renderer
 * ignores `onSave` / `onValueChange` / `readOnly`.
 */
export function PptxRenderer({ filePath }: FileRendererProps) {
  const { workspaceId } = useWorkspace();
  const [slides, setSlides] = useState<PptxSlide[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSlides(null);
    setError(null);
    if (!workspaceId) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(
          `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(filePath)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setError(`Failed to load presentation (HTTP ${res.status})`);
          return;
        }
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        const outline = await extractPptxOutline(buffer);
        if (cancelled) return;
        setSlides(outline);
      } catch (e) {
        if (cancelled) return;
        // `extractPptxOutline` throws "could not be parsed as a .pptx (…)".
        setError(`This file ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath]);

  if (error) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-ui text-danger">{error}</p>
        <DownloadFileButton filePath={filePath} />
      </div>
    );
  }

  if (slides === null) {
    return (
      <div className="flex min-h-40 items-center justify-center text-ui text-ink-muted">
        Loading presentation…
      </div>
    );
  }

  return (
    // No scroller of its own: the outline is a document, so it sits in
    // `KbDocumentShell`'s prose column and the column scrolls.
    <div className="min-w-0">
      {/* What this view is, and the way to the real thing — up front, not in
          a footnote: the one thing a reader must not believe is that the deck
          IS this outline. */}
      <div className="mb-4 flex items-center gap-3 rounded-sm bg-sunken px-3 py-2">
        <Presentation size={15} className="shrink-0 text-ink-faint" aria-hidden />
        <p className="min-w-0 flex-1 text-detail text-ink-muted">
          Text outline of the presentation — layout, images and formatting are not shown.
          Download the file to see the full slides.
        </p>
        <DownloadFileButton filePath={filePath} size="sm" />
      </div>
      {slides.map((slide) => (
        <section key={slide.number} className="mb-6">
          <h2 className="mb-2 border-b border-line pb-1 text-ui font-semibold text-ink">
            Slide {slide.number}
          </h2>
          {slide.paragraphs.length === 0 && slide.notes.length === 0 ? (
            <p className="text-detail italic text-ink-faint">No text on this slide.</p>
          ) : (
            slide.paragraphs.map((text, i) => (
              <p key={i} className="mb-1 text-ui text-ink">
                {text}
              </p>
            ))
          )}
          {slide.notes.length > 0 && (
            <div className="mt-2 border-l-2 border-line pl-3">
              <div className="mb-1 text-meta font-medium uppercase tracking-wide text-ink-faint">
                Notes
              </div>
              {slide.notes.map((text, i) => (
                <p key={i} className="mb-1 text-detail text-ink-muted">
                  {text}
                </p>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
