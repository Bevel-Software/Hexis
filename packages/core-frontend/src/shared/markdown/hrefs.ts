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
  const url = withoutLeadingPadding(href);
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');
}

/**
 * Drop the leading C0 controls and spaces a browser ignores before it reads a
 * scheme. An href written on its own line — which generated markup does all
 * the time —
 *
 *     <a href="
 *       https://example.com/docs
 *     ">docs</a>
 *
 * arrives here with that padding, and without this it reads as a path with no
 * scheme: the app would try to open `https://example.com/docs` as a file in
 * the workspace instead of opening a tab. Only the LEADING run matters; a
 * scheme is decided by what comes before the first colon.
 */
function withoutLeadingPadding(href: string): string {
  let i = 0;
  while (i < href.length && href.charCodeAt(i) <= 0x20) i += 1;
  return i === 0 ? href : href.slice(i);
}

/**
 * The schemes an external destination may be OPENED with. `isExternalHref`
 * answers "does this leave the workspace"; this answers "may we hand it to
 * `window.open`", and the two are not the same question.
 *
 * Leading whitespace and control characters are ignored, as a browser ignores
 * them, so padding disguises nothing: ` javascript:…` is still `javascript:`
 * and still absent from the list.
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
  const url = withoutLeadingPadding(href);
  if (url.startsWith('//')) return true;
  const colon = url.indexOf(':');
  if (colon < 0) return false;
  return OPENABLE_SCHEMES.has(url.slice(0, colon + 1).toLowerCase());
}

/**
 * The external schemes a link WRITTEN IN A PAGE'S MARKUP may keep — a strict
 * subset of {@link OPENABLE_SCHEMES}.
 *
 * `isOpenableExternalHref` answers "may we hand this to `window.open`" about a
 * destination the app has already decided to follow. This answers a narrower
 * question: which addresses an UNTRUSTED agent-authored page may put in front
 * of a reader as a clickable link. Only the three a document normally carries
 * — `http:`, `https:` and `mailto:`. A `tel:`, `sms:` or `geo:` address hands
 * the reader's device to another app; that is a thing a person writes in a
 * markdown document, not one a generated page gets to mint.
 *
 * Protocol-relative (`//cdn.example.com/…`) is NOT kept here, though
 * `isOpenableExternalHref` allows it: that one resolves against the page's own
 * scheme, and a sandboxed page's own origin is `about:srcdoc`, where there is
 * nothing sensible to inherit.
 *
 * A subset, deliberately. A scheme kept here that `isOpenableExternalHref`
 * rejected would survive sanitization and then do nothing when clicked; the
 * tests pin the containment so the two lists cannot drift into that state.
 */
const PAGE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function isPageLinkExternalHref(href: string): boolean {
  const url = withoutLeadingPadding(href);
  const colon = url.indexOf(':');
  if (colon < 0) return false;
  return PAGE_LINK_SCHEMES.has(url.slice(0, colon + 1).toLowerCase());
}
