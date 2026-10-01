/**
 * Whether a link or image destination leaves the workspace: anything with a
 * scheme (`https:`, `mailto:`, `sms:`, `geo:`, an app's own
 * `x-devonthink-item:`), or protocol-relative (`//cdn.example.com/…`).
 * Everything else is a path in the workspace.
 *
 * A bare name with a colon in it (`Notes: today.md`) reads as a scheme too,
 * as it does to a browser, and that is fine: react-markdown's URL transform
 * and rehype-sanitize both drop an href whose scheme they do not know before
 * the pipeline sees it, the frontmatter panel applies the same transform to
 * its own links, and an HTML file's anchor is parsed by the browser, which
 * agrees. So such a name cannot reach us as a link. A path with a segment
 * before the colon (`./Notes: today.md`, `Knowledge/Notes: today.md`) starts
 * with a character no scheme may contain and stays a workspace path.
 *
 * Shared by the routing module (link resolution) and the markdown pipeline
 * (image sources), which must not import each other: the pipeline is bundled
 * into the enterprise embed, which has no router.
 */
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

/**
 * The schemes an external destination may be OPENED with. `isExternalHref`
 * answers "does this leave the workspace"; this answers "may we hand it to
 * `window.open`", and the two are not the same question.
 *
 * `window.open('javascript:…')` runs the script in a document that inherits
 * the OPENER's origin — so an allowlist here is what keeps the HTML sandbox a
 * sandbox. Agent HTML gets `globalThis.bevel.navigate(anyString)`, which posts
 * straight to the host; sanitising the anchor hrefs in the document is not
 * enough when a script can call the bridge directly.
 *
 * Protocol-relative (`//cdn.example.com/…`) has no scheme to check and resolves
 * against the page's own — always http(s) here — so it is allowed.
 *
 * The list mirrors the schemes `isExternalHref` names as ordinary external
 * destinations. An exotic app scheme (`x-devonthink-item:`) is NOT on it and
 * stays a dead click, as it is today. Adding one is a deliberate decision,
 * not a default.
 */
const OPENABLE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'geo:']);

export function isOpenableExternalHref(href: string): boolean {
  if (href.startsWith('//')) return true;
  const colon = href.indexOf(':');
  if (colon < 0) return false;
  return OPENABLE_SCHEMES.has(href.slice(0, colon + 1).toLowerCase());
}
