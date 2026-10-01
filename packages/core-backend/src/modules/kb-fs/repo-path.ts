import path from 'node:path';
import { WorkflowValidationError } from '../../shared/domain-errors.js';

/**
 * Workspace-relative paths and the repository folder.
 *
 * A workspace directory holds the git clone as `<kbDirName>/` (plus transient
 * scratch such as `tmp/`). The agent filesystem, the lock keys and the human
 * editor all speak WORKSPACE-relative paths, so a path reaches git only when
 * it starts with that folder — and `KnowledgeBase/Foo.md` on its own names a
 * location BESIDE the clone, that nothing commits and nothing pushes.
 *
 * Which is why nothing on this platform resolves a workspace path for itself.
 * Every accepted path goes through {@link normalizeWorkspacePath} first, which
 * places it inside the clone; {@link assertInsideRepo} is then the check that
 * what came out really is in there. A route or a tool that resolved a path of
 * its own would be the drift this file exists to prevent — a `KnowledgeBase/`
 * folder, a `Plugins/` folder and eight uploaded documents sitting beside a
 * staging checkout is what it looked like the last time two spellings of this
 * rule were allowed to exist.
 */

/**
 * True when `wsPath` is the repository folder or lies under it.
 *
 * Judged segment by segment, not by string prefix: `knowledge-base/../x.md`
 * starts with the folder yet resolves beside it, and the filesystem's own
 * containment is against the WORKSPACE dir, so it would accept that path.
 * `.` and `..` segments (and empty ones from `//`) are therefore refused
 * outright, and so is any backslash: on Windows it separates segments too,
 * so `foo\..\..` would climb the same way. Both match what the commit layer
 * accepts. A single trailing slash on a directory path is tolerated.
 */
export function isInsideRepo(wsPath: string, kbDirName: string): boolean {
  if (typeof wsPath !== 'string' || wsPath.includes('\\')) return false;
  const segments = wsPath.replace(/\/$/, '').split('/');
  if (segments[0] !== kbDirName) return false;
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Refuse a workspace-relative path that would land outside the repository.
 * The message carries the corrected path so an agent can retry without
 * guessing; the payload carries a typed discriminator for callers that
 * switch on it, plus the same corrected path on its own, for a consumer
 * that cannot rely on the message surviving intact (the pending-commits
 * worker stores a sanitized, truncated copy).
 *
 * This is the check AFTER {@link normalizeWorkspacePath}, not instead of it:
 * the normaliser has already placed an unprefixed path inside the repository,
 * so what reaches here and still fails is a path no spelling can rescue.
 */
export function assertInsideRepo(wsPath: string, kbDirName: string): void {
  if (isInsideRepo(wsPath, kbDirName)) return;
  // The suggestion collapses what made the path wrong: backslashes, leading
  // `./` or `/`, and any `..` climbing back out (a bare `..` included, so the
  // suggestion is never itself a climb). The agent gets a path it can use.
  const normalized = path.posix
    .normalize(String(wsPath).replace(/\\/g, '/').replace(/^(\.\/|\/)+/, ''))
    .replace(/^(\.\.(\/|$))+/, '')
    .replace(/^\.$/, '');
  const corrected = isInsideRepo(normalized, kbDirName) ? normalized : `${kbDirName}/${normalized}`;
  throw new WorkflowValidationError(
    `"${wsPath}" is outside the knowledge base repository: paths are workspace-relative, must start with "${kbDirName}/" and may not contain "." or ".." segments or backslashes. ` +
      `Use "${corrected}" instead. A file written without that prefix lands beside the repository, where it is never committed or pushed.`,
    { kind: 'path-outside-repo', path: wsPath, kbDirName, corrected },
  );
}

/**
 * THE normaliser: any accepted workspace path as a REPOSITORY path.
 *
 * Three cases, and only three:
 *  - Already under `<kbDirName>/` (the root-anchored `/<kbDirName>/…` form the
 *    app's Copy path gives included, because that is the form a Markdown link
 *    resolves from and people paste the same text into an agent): returned as
 *    it is.
 *  - Anything else: placed under `<kbDirName>/`. `KnowledgeBase/Report.md` is
 *    not a location beside the clone any more — it is the page of that name
 *    inside it, which is what every caller that ever sent it meant.
 *  - `.` or `..` segments, a backslash, or an absolute path: refused, with
 *    {@link assertInsideRepo}'s message. Those are not spellings of a
 *    repository path, they are attempts to leave one, and a normaliser that
 *    "fixed" them would launder a traversal into a write.
 *
 * A leading `./` and repeated slashes are stripped rather than refused — they
 * are spellings of one path, which is what `canonicalRelativePath` has always
 * said, and ONE identity per file is what the write turns and the lock rows
 * coordinate on. Every other `.` segment is a refusal.
 */
export function normalizeWorkspacePath(wsPath: string, kbDirName: string): string {
  /** The refusal, with {@link assertInsideRepo}'s message and corrected path. */
  const refuse = (): never => {
    assertInsideRepo(wsPath, kbDirName);
    // Unreachable: everything that gets here fails `isInsideRepo` by
    // construction. Spelled out rather than trusted, so a future edit that
    // breaks the correspondence fails loudly instead of returning a bad path.
    throw new Error(`unreachable: "${wsPath}" was refused but is inside the repository`);
  };
  // A non-string arrives from JSON, not from TypeScript: refuse it as the path
  // it is not, rather than crash on `.startsWith`.
  if (typeof wsPath !== 'string') refuse();
  // `\` separates segments on Windows, so `foo\..\..` is a climb this cannot
  // read. Refused before anything is collapsed, never rewritten to `/`.
  if (wsPath.includes('\\')) refuse();
  // The root-anchored form, and ONLY for the repository folder: `/<kbDirName>/…`
  // is what the app's Copy path gives (it is the form a Markdown link resolves
  // from) and names the same workspace path. `/tmp/x` and `//x` are not that
  // form; they stay absolute, which is a refusal — `path.resolve` lets an
  // absolute path win over the workspace dir, so laundering one would be the
  // whole bug.
  const rooted =
    wsPath === `/${kbDirName}` || wsPath.startsWith(`/${kbDirName}/`) ? wsPath.slice(1) : wsPath;
  // `C:/Windows/System32` and the drive-relative `C:x` are absolute too, and
  // carry neither a leading slash nor a backslash — so they are named here
  // rather than left to the two checks above. On Windows `path.resolve` reads
  // the drive and the workspace dir loses; refused, like every other absolute.
  if (rooted.startsWith('/') || /^[A-Za-z]:/.test(rooted)) refuse();
  // A leading `./` and repeated slashes are SPELLINGS, not paths: `x/a.md`,
  // `./x/a.md` and `x//a.md` are one file, which is what `canonicalRelativePath`
  // has always said and what the write turns and the lock rows coordinate on.
  // Collapsed here so one identity comes out whichever way it went in.
  const segments = rooted.replace(/^\.\//, '').split('/').filter((segment) => segment !== '');
  // `.` deeper in, and `..` anywhere, are not spellings of the same path —
  // `knowledge-base/Public/../Locked/x.md` is judged under one folder and
  // written in another — so they are refused rather than resolved.
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) refuse();
  // A directory path may carry a single trailing slash; keep the caller's.
  const canonical = segments.join('/') + (rooted.endsWith('/') ? '/' : '');
  return segments[0] === kbDirName ? canonical : `${kbDirName}/${canonical}`;
}

/**
 * Refuse a repository-root folder named exactly `<kbDirName>`.
 *
 * Consequence of normalising rather than refusing: `knowledge-base/x` has to
 * mean ONE thing, and it means the repository's own `x`. A repository folder
 * called `knowledge-base` would therefore be ambiguous — `knowledge-base/x`
 * is read as the checkout's `x`, and the folder is reachable only by spelling
 * the prefix twice — so the name is reserved at the root rather than left
 * ambiguous. An existing one is left alone: nothing here deletes it, and a
 * delete or a move OUT of it stays possible so an operator can clean it up.
 *
 * Case-INSENSITIVELY, whatever this host's filesystem does. On macOS or
 * Windows `Knowledge-Base/` and `knowledge-base/` are one folder, so a
 * case variant would create exactly the unreachable folder this refuses; on
 * Linux they are two, and refusing the variant costs a name nobody should
 * want at the root of a repository that is cloned onto all three.
 */
export function assertRepoRootNameFree(wsPath: string, kbDirName: string): void {
  const segments = String(wsPath).replace(/\/+$/, '').split('/');
  const reserved = kbDirName.toLowerCase();
  if (segments[0] !== kbDirName || segments[1]?.toLowerCase() !== reserved) return;
  throw new WorkflowValidationError(
    `"${segments[1]}" is reserved: it is the checkout folder's name. A folder of that name at the repository root ` +
      `could never be reached — every workspace path starting with "${kbDirName}/" names the checkout itself — so it cannot be created, moved to or renamed to.` +
      // Said only when the caller spelled it differently, so the ordinary
      // refusal stays one sentence about one name.
      (segments[1] === kbDirName ? '' : ` A different case is the same folder wherever the repository is cloned onto a case-insensitive filesystem, so "${kbDirName}" is refused in every spelling.`),
    { kind: 'reserved-root-name', path: wsPath, kbDirName },
  );
}

/**
 * {@link assertRepoRootNameFree} over the arguments of a tool call that CREATES
 * something — `keys` names the inputs that are destinations (`path` of a
 * write or a mkdir, `dest` of a copy or a move, `destination` of an unzip, and
 * `files` for each `files[].path` of a batch write). Never a source: a move or
 * a delete OUT of an existing reserved folder is how it gets cleaned up.
 *
 * The routes enforce the reservation inside `WorkspaceService`; the MCP tools
 * write through the locking filesystem, which never enters that service, so
 * this is where the same rule meets them — after {@link normalizePathArgs},
 * on the normalised path.
 */
export function assertRepoRootNameFreeArgs(
  args: Record<string, unknown>,
  kbDirName: string,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (key === 'files') {
      if (!Array.isArray(args.files)) continue;
      for (const f of args.files) {
        const p = f && typeof f === 'object' ? (f as Record<string, unknown>).path : undefined;
        if (typeof p === 'string') assertRepoRootNameFree(p, kbDirName);
      }
      continue;
    }
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) assertRepoRootNameFree(value, kbDirName);
  }
}

/**
 * Refuse a checkout folder name that is also one of the repository's own root
 * names (the knowledge, skills or plugins root, or the agent guide's file).
 *
 * The normaliser reads a path whose first segment is `<kbDirName>` as already
 * inside the checkout. Were the checkout folder called `KnowledgeBase` — the
 * default name of the knowledge root — `KnowledgeBase/Report.md` would mean
 * the checkout's OWN `Report.md`, never the page under the knowledge root, and
 * {@link assertRepoRootNameFree} would refuse the knowledge root itself as a
 * reserved name. Both settings are the operator's to choose, so the collision
 * is refused at boot, by name, rather than discovered one misplaced write at a
 * time. Case-insensitive, for the same reason the reservation is.
 */
export function assertKbDirNameFree(
  kbDirName: string,
  layout: { knowledgeBaseDir: string; skillsDir: string; pluginsDir: string; agentsFile: string },
): void {
  const taken = kbDirName.toLowerCase();
  const collision = (
    [
      ['knowledgeBaseDir', layout.knowledgeBaseDir],
      ['skillsDir', layout.skillsDir],
      ['pluginsDir', layout.pluginsDir],
      ['agentsFile', layout.agentsFile],
    ] as const
  ).find(([, name]) => name.toLowerCase() === taken);
  if (!collision) return;
  throw new Error(
    `The checkout folder name (kbDirName / KB_DIR_NAME) is "${kbDirName}", which is also the repository's ` +
      `${collision[0]} ("${collision[1]}"). Every workspace path starting with that name is read as the checkout itself, ` +
      `so the repository's own "${collision[1]}" could never be named. Give the checkout folder a name none of the ` +
      `repository's root folders or files use.`,
  );
}

/** The tool inputs that carry a workspace path. */
const PATH_ARG_KEYS = ['path', 'src', 'dest', 'destination'] as const;

/**
 * {@link normalizeWorkspacePath} over a tool call's arguments: every
 * path-shaped input, including each `files[].path` of a batch write. Returns a
 * copy. This is where the MCP surface meets the normaliser — one call, before
 * any handler runs, so no tool keeps a resolver of its own.
 *
 * `skip` is for the one input that is not a workspace path at all: `read_file`
 * also takes a `__tool_chain_spill__/…` ref, which belongs to no workspace and
 * must reach the handler as written. An absent or non-string value is left
 * alone too — the handler's own required-argument message is better than a
 * path refusal about `undefined`.
 */
export function normalizePathArgs(
  args: Record<string, unknown>,
  kbDirName: string,
  skip?: (value: string) => boolean,
): Record<string, unknown> {
  const one = (value: unknown): unknown =>
    typeof value !== 'string' || value.length === 0 || skip?.(value)
      ? value
      : normalizeWorkspacePath(value, kbDirName);
  const out: Record<string, unknown> = { ...args };
  for (const key of PATH_ARG_KEYS) {
    if (key in out) out[key] = one(out[key]);
  }
  if (Array.isArray(out.files)) {
    out.files = out.files.map((f: unknown) =>
      f && typeof f === 'object' && 'path' in f
        ? { ...(f as Record<string, unknown>), path: one((f as Record<string, unknown>).path) }
        : f,
    );
  }
  return out;
}
