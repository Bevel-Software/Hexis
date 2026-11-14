/**
 * The content type a raw route declares for bytes a renderer fetches to
 * draw INLINE — the app's `/raw` file route and the embed's raw route read
 * it from here, so a picture or a document the app shows is the same type
 * inside a chat. Anything outside this table is `application/octet-stream`:
 * bytes the browser is told nothing about, under `nosniff`, so a file the
 * table does not name can never be promoted to active content.
 *
 * SVG is listed because the renderers draw it through `<img>`, where its
 * scripts never run; a route that serves it as a DOCUMENT sandboxes it (see
 * the routes), and a download of it is forced to octet-stream there.
 */
const RAW_INLINE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const OCTET_STREAM = 'application/octet-stream';

/** The lower-cased extension of `path`, dot included; `''` when it has none. */
export function rawExtensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

/** The inline content type for `path`'s extension, `application/octet-stream` when the table has none. */
export function rawMimeFor(path: string): string {
  return RAW_INLINE_MIME[rawExtensionOf(path)] ?? OCTET_STREAM;
}
