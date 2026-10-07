/**
 * A knowledge-base reference resolved from whatever a consumer hands the
 * mint: a pasted app URL, a repo-relative path, or a bare node id.
 *
 * Two consumers share this grammar and must keep sharing it — the MCP
 * `open_page` tool (a path, from a model) and the Atlassian connector (a
 * `content:` marker, from a person pasting into a ticket). The mint contract
 * is the boundary between Hexis and that connector's own repository, so this
 * parse is the one part of the embed that may not change shape.
 */

/** A reference to a FILE, and optionally one heading inside it. */
export interface EmbedRef {
  /** Repo-relative path, e.g. `Product/Knowledge/Thing.md`. */
  repoRelative: string;
  /** Heading anchor slug (e.g. `problem-statement`), or undefined for the whole file. */
  slug?: string;
}

/**
 * A node-id reference — the canonical copy-link form `/workspace/<branch>/<id>`.
 * Core has no node graph to resolve an id with, so it is handed back for a
 * deployment that does (see `EmbedNodeIdResolver`); without one the mint
 * refuses it the way it refuses any unresolvable reference.
 */
export interface EmbedIdRef {
  nodeId: string;
  slug?: string;
}

/** A node frontmatter id: lowercase alphanumeric + hyphens, no separators/dots. */
const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Thrown when a reference can't be parsed into a safe path or an id. */
export class EmbedRefParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedRefParseError';
  }
}

/** `decodeURIComponent` that turns a malformed escape into a parse error. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new EmbedRefParseError('Malformed percent-encoding in reference');
  }
}

/**
 * A safe repo-relative embeddable path: rejects absolute paths, traversal,
 * control characters and percent-encoded separators.
 *
 * Deliberately NO extension allowlist. The enterprise panel this grammar came
 * from accepted `.md`, `.html` and `.htm` only, because those were the two
 * things its own renderer could draw. The embed now renders with the APP's
 * renderer for the file's type — every type the app renders, documents and
 * images included — so an extension list here would be a second, narrower
 * answer to "what can be shown", and the one that is wrong.
 */
export function isSafeRepoRelativeEmbedPath(repoRelative: string): boolean {
  if (!repoRelative) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(repoRelative)) return false;
  if (/%2e|%2f|%5c/i.test(repoRelative)) return false;
  const norm = repoRelative.replace(/\\/g, '/');
  if (norm.startsWith('/')) return false;
  return norm.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Whether a reference that parses as a safe path should instead be read as a
 * node id.
 *
 * With the extension allowlist gone, `my-process` is BOTH a legal path and a
 * legal id, so the two forms need a rule rather than a fallback. The rule is
 * the shape the copy-link produces: an id is one segment with no dot in it
 * (`/workspace/<branch>/<id>`). Anything with a separator or an extension is
 * a path, which is every real file in the repository.
 */
function looksLikeNodeId(repoRelative: string): boolean {
  return !repoRelative.includes('/') && !repoRelative.includes('.') && NODE_ID_RE.test(repoRelative);
}

/**
 * Parse a reference into a file path or a node id. Accepts:
 *   - A full app URL: `https://<host>/workspace/<branch>/<kbDir>/<path>#<slug>`
 *     (also `/embed/<branch>/…`), optionally angle-bracketed and/or
 *     `content:`-prefixed.
 *   - A bare path, with or without a fragment: `<kbDir>/<path>#<slug>`,
 *     `<path>#<slug>`, or just `<path>` (whole file).
 *   - A bare node id (the copy-link form).
 *
 * The branch segment in a URL is intentionally ignored: the editable embed
 * always targets the deployment's default branch. A missing `#slug` means
 * "the whole file".
 */
/**
 * A separator spelled `%2F` or `%5C` is refused BEFORE decoding: decoded, it
 * becomes a real `/` that the safe-path check can no longer tell from one
 * the caller wrote, and `Data%2FThing.md` would name `Data/Thing.md`.
 */
function refuseEncodedSeparators(rawPath: string): void {
  if (/%2f|%5c/i.test(rawPath)) {
    throw new EmbedRefParseError(`Not a safe knowledge-base path: ${rawPath}`);
  }
}

export function parseEmbedRef(raw: string, kbDirName: string): EmbedRef | EmbedIdRef {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new EmbedRefParseError('Empty reference');
  }

  // A person pastes the marker, so the two decorations arrive in either order
  // — `content: <url>` and `<content: url>` are both things a ticket holds.
  // Peeled in a loop rather than in one fixed order, so neither spelling
  // leaves a `content:` prefix inside the path (where it reads as a scheme and
  // the whole reference is refused).
  let ref = raw.trim();
  for (let i = 0; i < 4; i += 1) {
    const peeled = ref
      .replace(/^content:\s*/i, '')
      .replace(/^<+/, '')
      .replace(/>+$/, '')
      .trim();
    if (peeled === ref) break;
    ref = peeled;
  }

  let pathPart: string;
  let fragment: string;

  if (/^https?:\/\//i.test(ref)) {
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      throw new EmbedRefParseError(`Not a valid URL: ${ref}`);
    }
    fragment = safeDecode(url.hash.replace(/^#/, ''));
    refuseEncodedSeparators(url.pathname);
    const segments = url.pathname.split('/').filter(Boolean).map((s) => safeDecode(s));
    if ((segments[0] === 'workspace' || segments[0] === 'embed') && segments.length >= 3) {
      pathPart = segments.slice(2).join('/');
    } else {
      pathPart = segments.join('/');
    }
  } else {
    const hashIndex = ref.indexOf('#');
    fragment = hashIndex >= 0 ? safeDecode(ref.slice(hashIndex + 1)) : '';
    const rawPath = hashIndex >= 0 ? ref.slice(0, hashIndex) : ref;
    refuseEncodedSeparators(rawPath);
    pathPart = rawPath.split('/').map((s) => safeDecode(s)).join('/');
  }

  let repoRelative = pathPart.replace(/^\.\//, '').replace(/^\/+/, '');
  if (repoRelative.startsWith(`${kbDirName}/`)) {
    repoRelative = repoRelative.slice(kbDirName.length + 1);
  }

  const slug = fragment.trim() || undefined;

  if (looksLikeNodeId(repoRelative)) return { nodeId: repoRelative, slug };
  if (isSafeRepoRelativeEmbedPath(repoRelative)) return { repoRelative, slug };
  throw new EmbedRefParseError(`Not a safe knowledge-base path: ${pathPart}`);
}
