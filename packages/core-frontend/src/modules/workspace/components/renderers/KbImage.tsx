import { useState, type HTMLAttributes, type ImgHTMLAttributes } from 'react';
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

const PLACEHOLDER_CLASS =
  'inline-flex max-w-full items-center gap-1.5 rounded-sm border border-dashed border-line-strong bg-sunken px-2 py-1 align-middle text-xs text-ink-muted';

/**
 * What a placeholder inherits from the image it stands in for: the attributes
 * that tie the image to the DOCUMENT, never the ones that draw it or name it.
 * Its `id`, so a link to the figure still lands; `aria-describedby`, so a
 * caption still describes it; its language and direction. `width`, `height`,
 * `align` and the rest size a picture that is not there. `aria-label` and
 * `aria-labelledby` stay behind: the placeholder's NAME must say the picture
 * is missing, and `aria-labelledby` outranks the `aria-label` we set, so
 * inheriting it would name the placeholder after the caption instead. The
 * sanitizer keeps no other ARIA attribute on an image (hast-util-sanitize's
 * `aria` list), so nothing that hides an element can arrive.
 */
const INHERITED_ATTRIBUTES = new Set(['id', 'lang', 'dir', 'aria-describedby']);

function inheritedAttributes(rest: ImgHTMLAttributes<HTMLImageElement>): HTMLAttributes<HTMLElement> {
  const inherited: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    if (INHERITED_ATTRIBUTES.has(name)) inherited[name] = value;
  }
  return inherited;
}

/**
 * What an image leaves behind when there is nothing to show. A `role="img"`
 * whose accessible name is the note, so a screen reader hears what a sighted
 * reader sees; the alt text stays, so the author's description is not lost
 * with the picture. A span, not a div: an image sits inside a paragraph, and
 * a block there is invalid markup.
 *
 * With `onRetry` it is a button. The one failure nothing else clears is a
 * load error on a URL that does not change (a network blip, a 403 that lifts,
 * a file fixed on disk with no event), and the reader is the one who knows it
 * is worth another try; retrying on our own would loop error → image → error.
 *
 * The author's attributes come first, so ours hold.
 */
function ImagePlaceholder({
  alt,
  note,
  onRetry,
  attributes = {},
}: {
  alt?: string;
  note: string;
  onRetry?: () => void;
  attributes?: HTMLAttributes<HTMLElement>;
}) {
  const label = alt ? `${alt}. ${note}` : note;
  const body = (
    <>
      <ImageOff size={14} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 break-words">
        {alt ? <span className="text-ink">{alt} </span> : null}
        {note}
        {onRetry ? <span className="ml-1.5 text-accent">Retry</span> : null}
      </span>
    </>
  );
  if (onRetry) {
    return (
      <button
        {...attributes}
        type="button"
        onClick={onRetry}
        aria-label={`${label}. Retry`}
        title="Try loading the image again"
        className={`${PLACEHOLDER_CLASS} cursor-pointer hover:text-ink`}
      >
        {body}
      </button>
    );
  }
  return (
    <span {...attributes} role="img" aria-label={label} title={note} className={PLACEHOLDER_CLASS}>
      {body}
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
 *                                             placeholder "Couldn't load image: <path>",
 *                                             with Retry
 *   ./assets/x.png             {src: null}    placeholder with the resolver's note
 *   ./assets/x.png             null           placeholder "Couldn't load image: <src>"
 *
 * The sanitizer removes a `data:` src before this runs, so the empty-src case
 * cannot know the cause and says what to do instead. A native `<img>` error
 * carries no HTTP status, so a failure says "couldn't load", never "not found".
 *
 * The failure state is keyed by the resolved src: an author who fixes the
 * link, or a teammate who uploads the missing file (which bumps the revision
 * in the URL), sees the image without a reload; the same URL is tried again
 * on request. Every attribute the sanitizer let through reaches the element
 * (`id`, `align`, `aria-*`; `srcset` and `class` never survive it), and a
 * placeholder keeps the ones that place the image in the document (see
 * `inheritedAttributes`). Every
 * `<img>` carries `loading="lazy"` (thirty screenshots on a Loop export must
 * not all fetch at once) and `referrerPolicy="no-referrer"` (an external image
 * host learns nothing about which page of the knowledge base cited it).
 */
export function KbImage({
  src,
  alt,
  title,
  resolve,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { resolve?: KbImageResolver }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const attributes = inheritedAttributes(rest);
  if (!src) return <ImagePlaceholder alt={alt} note={NO_SOURCE_NOTE} attributes={attributes} />;
  // Ours come after the author's, so they hold on every image.
  const shared = {
    ...rest,
    alt,
    title,
    loading: 'lazy' as const,
    referrerPolicy: 'no-referrer' as const,
  };
  if (!resolve || isExternalHref(src)) return <img src={src} {...shared} />;
  const resolved = resolve(src);
  if (!resolved) {
    return <ImagePlaceholder alt={alt} note={`Couldn't load image: ${src}`} attributes={attributes} />;
  }
  if (resolved.src === null) {
    return (
      <ImagePlaceholder
        alt={alt}
        note={`${resolved.note}: ${resolved.path}`}
        attributes={attributes}
      />
    );
  }
  if (failedSrc === resolved.src) {
    return (
      <ImagePlaceholder
        alt={alt}
        note={`Couldn't load image: ${resolved.path}`}
        onRetry={() => setFailedSrc(null)}
        attributes={attributes}
      />
    );
  }
  return <img src={resolved.src} {...shared} onError={() => setFailedSrc(resolved.src)} />;
}
