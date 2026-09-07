/**
 * Whether a link or image destination leaves the workspace: anything with a
 * scheme (`https:`, `mailto:`, `sms:`, `geo:`, an app's own
 * `x-devonthink-item:`), or protocol-relative (`//cdn.example.com/…`).
 * Everything else is a path in the workspace.
 *
 * A bare name with a colon in it (`Notes: today.md`) reads as a scheme too,
 * and that is fine: react-markdown's URL transform and rehype-sanitize both
 * drop an href whose scheme they do not know before the pipeline sees it, so
 * such a name cannot reach us either way. A path with a segment before the
 * colon (`./Notes: today.md`, `Knowledge/Notes: today.md`) starts with a
 * character no scheme may contain and stays a workspace path.
 *
 * Shared by the routing module (link resolution) and the markdown pipeline
 * (image sources), which must not import each other: the pipeline is bundled
 * into the enterprise embed, which has no router.
 */
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}
