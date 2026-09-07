import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { isExternalHref } from '../../../../shared/markdown/hrefs';

/**
 * What a surface knows about an image `src` the page cannot serve as written.
 * Returned by `resolveImage` in `useKbMarkdownComponents`.
 */
export type KbImageSource =
  /** Serve these bytes; `path` names the workspace file if they fail to load. */
  | { src: string; path: string }
  /** Do not fetch. Show the placeholder with `note`, naming `path`. */
  | { src: null; path: string; note: string };

/**
 * Turns the `src` an author wrote (`./assets/x.png`, `/workspace/<b>/<p>`)
 * into a source the browser can load, or says why it will not be loaded.
 * `null` means the resolver could not place the path at all (no workspace
 * yet); the placeholder then names the raw src.
 */
export type KbImageResolver = (src: string) => KbImageSource | null;

const NO_SOURCE_NOTE =
  'This image has no usable source. Inline data: images are not supported; save the file under ./assets/ and link it.';

/**
 * What an image leaves behind when there is nothing to show. A `role="img"`
 * whose accessible name is the note, so a screen reader hears what a sighted
 * reader sees; the alt text stays, so the author's description is not lost
 * with the picture. A span, not a div: an image sits inside a paragraph, and
 * a block there is invalid markup.
 */
function ImagePlaceholder({ alt, note }: { alt?: string; note: string }) {
  return (
    <span
      role="img"
      aria-label={alt ? `${alt}. ${note}` : note}
      title={note}
      className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-dashed border-line-strong bg-sunken px-2 py-1 align-middle text-xs text-ink-muted"
    >
      <ImageOff size={14} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 break-words">
        {alt ? <span className="text-ink">{alt} </span> : null}
        {note}
      </span>
    </span>
  );
}

/**
 * The six inputs an image can arrive with, and what each renders:
 *
 *   src                        resolver     →  rendered
 *   ─────────────────────────  ───────────  ──────────────────────────────────────────
 *   http(s)://… or //…         any            <img src as-is>
 *   '' (stripped: was data:)   any            placeholder: no usable source
 *   ./assets/x.png             none           <img src as-is>  (the embed, as before)
 *   ./assets/x.png             {src, path}    <img src=raw-file URL>; on error the
 *                                             placeholder "Couldn't load image: <path>"
 *   ./assets/x.png             {src: null}    placeholder with the resolver's note
 *   ./assets/x.png             null           placeholder "Couldn't load image: <src>"
 *
 * The sanitizer removes a `data:` src before this runs, so the empty-src case
 * cannot know the cause and says what to do instead. A native `<img>` error
 * carries no HTTP status, so a failure says "couldn't load", never "not found".
 *
 * The failure state is keyed by the resolved src: an author who fixes the
 * link, or a teammate who uploads the missing file (which bumps the version
 * in the URL), sees the image without a reload. Every `<img>` carries
 * `loading="lazy"` (thirty screenshots on a Loop export must not all fetch at
 * once) and `referrerPolicy="no-referrer"` (an external image host learns
 * nothing about which page of the knowledge base cited it).
 */
export function KbImage({
  src,
  alt,
  title,
  width,
  height,
  resolve,
}: {
  src?: string;
  alt?: string;
  title?: string;
  width?: number | string;
  height?: number | string;
  resolve?: KbImageResolver;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src) return <ImagePlaceholder alt={alt} note={NO_SOURCE_NOTE} />;
  const shared = {
    alt,
    title,
    width,
    height,
    loading: 'lazy' as const,
    referrerPolicy: 'no-referrer' as const,
  };
  if (!resolve || isExternalHref(src)) return <img src={src} {...shared} />;
  const resolved = resolve(src);
  if (!resolved) return <ImagePlaceholder alt={alt} note={`Couldn't load image: ${src}`} />;
  if (resolved.src === null) {
    return <ImagePlaceholder alt={alt} note={`${resolved.note}: ${resolved.path}`} />;
  }
  if (failedSrc === resolved.src) {
    return <ImagePlaceholder alt={alt} note={`Couldn't load image: ${resolved.path}`} />;
  }
  return <img src={resolved.src} {...shared} onError={() => setFailedSrc(resolved.src)} />;
}
