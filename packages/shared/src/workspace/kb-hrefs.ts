/**
 * The grammar of a link written in a knowledge page, in one place for every
 * surface that follows one: the app (its routing and markdown pipeline
 * re-export these), the enterprise embed, and the local MCP server's
 * knowledge views (hexis-mcp), which resolve a link a view posts with this
 * same `resolveKbHref` rather than a grammar of their own.
 *
 * Pure functions, no imports: safe to bundle anywhere.
 */

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
  const url = normalizeHref(href);
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');
}

/**
 * An href as a browser reads it: the C0 controls and spaces at either end
 * dropped, and every ASCII tab, line feed and carriage return removed from
 * inside. An href written on its own line — which generated markup does all
 * the time —
 *
 *     <a href="
 *       https://example.com/docs
 *     ">docs</a>
 *
 * arrives here with that padding, and without this it reads as a path with no
 * scheme: the app would try to open `https://example.com/docs` as a file in
 * the workspace instead of opening a tab. By the same rule
 * ` JaVaScRiPt:alert(1)` and `java&#9;script:alert(1)` are `javascript:` to
 * the checks below, because they are `javascript:` to a browser that
 * navigates them.
 *
 * THE ONE RULE, FOR EVERY READER OF AN HREF. The scheme checks here, the
 * sanitizer's keep-decision and the resolver that turns a kept href into a
 * path all run it, so the string judged is the string followed. A padded
 * `'  Board.html  '` that the sanitizer keeps must not reach
 * `resolveRelativePath` with the spaces still on it — they would become part
 * of a filename nobody wrote.
 *
 * It takes an inner tab out of a workspace path too (`'No\ttes.md'` resolves
 * as `'Notes.md'`), which is what a browser does with the same href; a file
 * whose name contains a literal tab is not reachable by a written link
 * either way.
 */
export function normalizeHref(href: string): string {
  const inner = href.replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = inner.length;
  // Written as a scan rather than a regex character class, which would be a
  // pattern full of literal control characters.
  while (start < end && inner.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && inner.charCodeAt(end - 1) <= 0x20) end -= 1;
  return start === 0 && end === inner.length ? inner : inner.slice(start, end);
}

/**
 * The schemes an external destination may be OPENED with. `isExternalHref`
 * answers "does this leave the workspace"; this answers "may we hand it to
 * `window.open`", and the two are not the same question.
 *
 * The href is read through {@link normalizeHref}, so padding and inner
 * controls disguise nothing: ` javascript:…` is still `javascript:` and still
 * absent from the list.
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
  const url = normalizeHref(href);
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
  const url = normalizeHref(href);
  const colon = url.indexOf(':');
  if (colon < 0) return false;
  return PAGE_LINK_SCHEMES.has(url.slice(0, colon + 1).toLowerCase());
}

export const KB_ROUTE_PREFIX = '/workspace';

/**
 * Self-heal a workspace-relative path the model may have mangled when it wrote
 * a citation link. The LLM sometimes corrupts the URL by inserting a junk
 * segment before the KB dir — e.g. `bevel-process-of-truth/knowledge-base/…`,
 * a blend of the branch name and the dir name — which then 404s. A well-formed
 * KB path has `<kbDirName>/` as its first segment, so when that segment shows up
 * *later* in the path we drop everything before it. No-op when the path is
 * already well-formed (kbDirName first) or has no `<kbDirName>` segment at all
 * (a non-repo file like `my-notes.txt`). Segment-exact match avoids the
 * `<kbDirName>-backup/…` substring foot-gun.
 */
export function stripJunkBeforeKbDir(path: string, kbDirName: string | null): string {
  if (!kbDirName) return path;
  const segs = path.split('/');
  const idx = segs.indexOf(kbDirName);
  return idx > 0 ? segs.slice(idx).join('/') : path;
}

export function kbFileUrl(branch: string, relativePath: string = ''): string {
  const branchPart = encodeURIComponent(branch);
  if (!relativePath) return `${KB_ROUTE_PREFIX}/${branchPart}`;
  const pathPart = relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `${KB_ROUTE_PREFIX}/${branchPart}/${pathPart}`;
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Resolve a relative path against a base file path (like `path.resolve`, but for
 * workspace-relative paths). Used to turn an internal link's href
 * (`../NodeTypes/Process.md`) into a workspace-relative path before navigating.
 */
export function resolveRelativePath(basePath: string, relative: string): string {
  // Root-relative hrefs (`/Knowledge/Node.md`) are anchored at the workspace
  // root, not the current file — resolve against an empty base so the leading
  // `/` doesn't get appended onto `baseDir` (`Knowledge/Knowledge/Node.md`).
  const baseDir =
    relative.startsWith('/')
      ? ''
      : basePath.includes('/')
        ? basePath.slice(0, basePath.lastIndexOf('/'))
        : '';
  const parts = baseDir ? baseDir.split('/') : [];
  for (const segment of relative.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

/**
 * A link destination as written in a knowledge page, classified and resolved.
 */
export type KbHref =
  | { kind: 'external' }
  | { kind: 'workspace'; branch: string | null; path: string; hash: string };

/**
 * The grammar of a link or image destination, as one function. `basePath` is
 * the file the link sits in; `kbDirName` drives the junk-segment repair.
 *
 *   href                                    kind       branch    path                  hash
 *   ──────────────────────────────────────  ─────────  ────────  ────────────────────  ──────
 *   https://x.y/z, mailto:a@b, tel:…        external
 *   //cdn.x.y/z  (protocol-relative)        external
 *   /workspace/<b>/<p>#h  (absolute app)    workspace  <b>       <p>, junk stripped    #h
 *   /workspace/<b>                          workspace  <b>       ''
 *   ../NodeTypes/Process.md#goal            workspace  null      resolved vs basePath  #goal
 *   /KB/x.png  (root-relative)              workspace  null      KB/x.png
 *   #overview  (same document)              workspace  null      basePath              #overview
 *   ''  (empty)                             null
 *
 * Percent-escapes are decoded (react-markdown encodes the spaces in a
 * destination; the file on disk has real spaces); a malformed escape is left
 * as-is, the tolerance `safeDecode` has always given the URL form. `branch` is
 * null for a relative link: the caller supplies the branch it is standing on.
 *
 * `repairMangledPath` runs {@link stripJunkBeforeKbDir} on the result. It is on
 * for a LINK, which may have been written by a model that mangled the path,
 * and off for an IMAGE, which was not: the repair rewrites any path whose
 * later segment happens to equal `kbDirName`, so on an image source it
 * truncates a correctly-authored `./assets/knowledge-base/shot.png` down to
 * `knowledge-base/shot.png` and the reader gets a placeholder where a picture
 * belongs. Same reasoning as `openWorkspacePath` below: a destination nobody
 * garbled needs no repair, and applying one can only find the wrong file.
 *
 * THE BRANCH RULE. A link handler navigates with the URL's branch, as
 * `openFile` always has: an absolute citation URL names the branch the cited
 * node lives on. An IMAGE resolver takes the path and ignores the branch: the
 * bytes come from the workspace the page is rendered from, so a cross-branch
 * image URL shows that tree's copy, or the placeholder when there is none.
 * Serving bytes at another branch is the `?ref=` item in TODOS.md.
 */
export function resolveKbHref(
  rawHref: string,
  {
    basePath,
    kbDirName,
    repairMangledPath = true,
  }: { basePath: string; kbDirName: string | null; repairMangledPath?: boolean },
): KbHref | null {
  // Read the href the way a browser reads it BEFORE anything is parsed out of
  // it, not just before the scheme check. An href written on its own line in
  // generated markup arrives padded, and `sanitizeAgentHtml` keeps it on that
  // reading — so every row of the table above has to see the same string, or a
  // padded `'  Board.html  '` resolves to a filename with spaces nobody wrote,
  // a padded `'  /workspace/…'` misses the prefix and resolves as a relative
  // path, and a padded `'  #goal'` loses its same-document row.
  const href = normalizeHref(rawHref);
  if (!href) return null;
  if (isExternalHref(href)) return { kind: 'external' };
  const hashIdx = href.indexOf('#');
  const hash = hashIdx >= 0 ? href.slice(hashIdx) : '';
  const location = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const repair = (path: string) => (repairMangledPath ? stripJunkBeforeKbDir(path, kbDirName) : path);
  // Same document: `#overview` names a heading in the file the link sits in,
  // not a destination to resolve. Without this row an empty location falls
  // through to `resolveRelativePath`, which drops the file segment off
  // `basePath` and hands the caller the PARENT DIRECTORY — a reader who
  // clicked a section link lands on a folder listing.
  if (!location) return { kind: 'workspace', branch: null, path: basePath, hash };
  if (location.startsWith(`${KB_ROUTE_PREFIX}/`)) {
    const rest = location.slice(KB_ROUTE_PREFIX.length + 1);
    const slashIdx = rest.indexOf('/');
    if (slashIdx < 0) return { kind: 'workspace', branch: safeDecode(rest), path: '', hash };
    return {
      kind: 'workspace',
      branch: safeDecode(rest.slice(0, slashIdx)),
      path: repair(safeDecode(rest.slice(slashIdx + 1))),
      hash,
    };
  }
  return {
    kind: 'workspace',
    branch: null,
    path: repair(resolveRelativePath(basePath, safeDecode(location))),
    hash,
  };
}

/**
 * A link written in a knowledge page, as the absolute address a host can open:
 * a knowledge-base destination becomes the deployment's
 * `<base>/workspace/<branch>/<path>#hash` URL, an external one is passed
 * through in its normalised spelling, and anything else is null.
 *
 * An external destination must pass the SCHEME ALLOWLIST
 * ({@link isOpenableExternalHref}): whoever is handed the result opens it, and
 * `javascript:alert(1)` is a destination the grammar happily calls
 * "external". A link that named its own branch keeps it; any other opens on
 * `branch`, the one the page was shown from.
 *
 * Shared by the app's embed and the local MCP server's knowledge views: both
 * hand a page's link to a host to open, and must agree on where it goes.
 */
export function kbHrefToAppUrl(
  href: string,
  { basePath, kbDirName, branch, base }: { basePath: string; kbDirName: string; branch: string; base: string },
): string | null {
  const target = resolveKbHref(href, { basePath, kbDirName });
  if (target === null) return null;
  if (target.kind === 'external') return isOpenableExternalHref(href) ? normalizeHref(href) : null;
  return `${base}${kbFileUrl(target.branch ?? branch, target.path)}${target.hash}`;
}
