/**
 * Whether a link or image destination leaves the workspace: an absolute URL
 * with a scheme and an authority (`https://…`, `ftp://…`), a protocol-relative
 * one (`//cdn.example.com/…`), or a scheme that names no file at all
 * (`mailto:`, `tel:`, `data:`, `blob:`, `javascript:`). Everything else is a
 * path in the workspace, including a name with a colon in it
 * (`Notes: today.md`), which a naive "has a scheme" test would send outside.
 *
 * Shared by the routing module (link resolution) and the markdown pipeline
 * (image sources), which must not import each other: the pipeline is bundled
 * into the enterprise embed, which has no router.
 */
export function isExternalHref(href: string): boolean {
  return (
    /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(href) ||
    /^(?:mailto|tel|data|blob|javascript):/i.test(href)
  );
}
