import {
  DEFAULT_KB_LAYOUT,
  FIXED_PLATFORM_FILE_NAMES,
  agentsFileOf,
  currentKbLayout,
  reservedRootDirNames,
  type KbLayout,
} from './kb-layout.js';

/**
 * The files the platform reads as configuration, not content. `access.md`
 * governs the folder it sits in and `.bevelignore` layers like `.gitignore`,
 * so both count at any depth; `roles.yaml` and the agent guide are read from
 * the repository root only, so a nested file of either name is ordinary
 * content. Moving one changes what the platform enforces, so moves refuse them.
 *
 * A FUNCTION, not a constant, and that is the whole of the configurable-guide
 * change on this side: the guide's name is a deployment setting, so the fourth
 * platform file is `HEXIS.md` on one deployment and `AGENTS.md` on the next —
 * and on the first, a root `AGENTS.md` is the CUSTOMER'S own conventions file,
 * which has to move and delete like any page. Every gate asks this rather than
 * reading a list captured at module load.
 */
export function platformFileNames(layout: KbLayout = currentKbLayout()): readonly string[] {
  return [...FIXED_PLATFORM_FILE_NAMES, agentsFileOf(layout)];
}

/**
 * The platform file names under the DEFAULT layout — what they were before the
 * guide could be renamed. Kept for callers that want the default answer rather
 * than this deployment's; anything judging a real path asks
 * {@link platformFileNames}, which knows what this deployment called its guide.
 */
export const PLATFORM_FILE_NAMES: readonly string[] = Object.freeze(
  platformFileNames(DEFAULT_KB_LAYOUT),
);

/** The platform files that are read wherever they sit, not only at the root. */
const PLATFORM_FILES_AT_ANY_DEPTH = new Set(['access.md', '.bevelignore']);

/** The names in effect, as a set — rebuilt per call, because the guide's is configurable. */
const platformFiles = (): ReadonlySet<string> => new Set(platformFileNames());

const normalize = (path: string): string => path.replace(/^\.?\/+/, '').replace(/\/+$/, '');

const baseName = (path: string): string => {
  const trimmed = normalize(path);
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
};

/**
 * A path that walks out of the repository (`..`) or stands still (`.`). The
 * restore exception is the one write allowed past a destination that denies
 * it, so it answers on the spelling it was handed and refuses anything whose
 * meaning depends on resolving it: `KnowledgeBase/../access.md` names the
 * root's file to a resolver and a nested one to a reader of segments. The
 * move's own path-safety check refuses these too — this gate does not lean on
 * that one.
 */
const hasTraversal = (path: string): boolean =>
  normalize(path).split('/').some((segment) => segment === '..' || segment === '.');

/**
 * Whether the repository-relative `repoRelativePath` is a platform file.
 * Exact spelling, as the platform reads it: `Access.md` is content. A caller
 * on a case-insensitive disk passes the path's on-disk spelling.
 */
export function isPlatformFile(repoRelativePath: string): boolean {
  const norm = normalize(repoRelativePath);
  const name = baseName(norm);
  if (!platformFiles().has(name)) return false;
  return PLATFORM_FILES_AT_ANY_DEPTH.has(name) || norm === name;
}

/** The one sentence every surface refuses a platform-file move with. */
export function platformFileRefusal(pathOrName: string): string {
  return `${baseName(pathOrName)} is a platform file and stays in its folder.`;
}

/**
 * The sentence a move is refused with when the DESTINATION would be a platform
 * file — a note renamed to `access.md`, or dragged onto the one that is there.
 * The other refusal keeps a platform file where the platform reads it; this one
 * keeps everything else from becoming one, which a rename on disk would
 * otherwise do silently: the folder would come back governed by rules nobody
 * wrote as rules.
 */
export function platformFileCreationRefusal(pathOrName: string): string {
  return `${baseName(pathOrName)} is a platform file name; a move cannot create a platform file.`;
}

/**
 * Whether `repoRelativeDir` is a folder the platform owns rather than content:
 * the repository root itself, or one of its reserved top-level folders
 * (`KnowledgeBase/`, `Skills/`, `Plugins/`, `Data/`, …). Deleting or moving
 * one takes a whole section of the knowledge base with it. Exact spelling; a
 * caller on a case-insensitive disk passes the path's on-disk spelling.
 */
export function isPlatformFolder(repoRelativeDir: string): boolean {
  const norm = normalize(repoRelativeDir);
  if (norm === '') return true;
  return !norm.includes('/') && reservedRootDirNames().has(norm);
}

/** The sentence a delete or move of a platform folder is refused with. */
export function platformFolderRefusal(repoRelativeDir: string): string {
  const norm = normalize(repoRelativeDir);
  return norm === ''
    ? 'The repository root is a platform folder and cannot be moved or deleted.'
    : `${norm}/ is a platform folder and cannot be moved or deleted.`;
}

/**
 * Whether the platform file at `repoRelativePath` sits directly in the
 * repository root — the copy every one of the four is read from there, and so
 * never the misplaced one: it is the copy a restore puts back. A nested
 * `access.md` or `.bevelignore` is a platform file too, but it layers on top
 * of the root's rather than standing in for it, which is why moving the
 * ROOT's copy into a folder is a move out and not a restore.
 */
export function isRootPlatformFile(repoRelativePath: string): boolean {
  return platformFiles().has(normalize(repoRelativePath));
}

/**
 * The place a misplaced platform file is allowed to be put back, when
 * `repoRelativeDestination` names one, and null when it does not.
 *
 * `roles.yaml` and the agent guide are read from the repository root and
 * nowhere else, so their one required location is the root. A nested `.bevelignore` is
 * read too (it layers, see `BevelIgnoreStack`), yet a restore of one lands at
 * the root only — a deliberate narrowing of the exception, not a claim about
 * where the file is read: the root's copy is the one whose absence breaks the
 * workspace, and a folder that never had a `.bevelignore` is not missing one.
 * `access.md` governs whatever folder it sits in, so a folder that has none
 * is a place one is missing from — WHETHER the folder has one is a fact about
 * the disk, which this pure predicate does not know and the caller checks
 * (see `AccessControlService.canRestorePlatformFile`).
 */
export type PlatformRestoreDestination =
  | { name: string; kind: 'root' }
  | { name: string; kind: 'folder-without-access-md'; dir: string };

export function platformRestoreDestination(
  repoRelativeDestination: string,
): PlatformRestoreDestination | null {
  const norm = normalize(repoRelativeDestination);
  if (hasTraversal(norm)) return null;
  const name = baseName(norm);
  if (!platformFiles().has(name)) return null;
  if (name === 'access.md') {
    const slash = norm.lastIndexOf('/');
    return { name, kind: 'folder-without-access-md', dir: slash === -1 ? '' : norm.slice(0, slash) };
  }
  return norm === name ? { name, kind: 'root' } : null;
}

/**
 * Whether moving `repoRelativeSource` to `repoRelativeDestination` has the
 * SHAPE of a platform-file restore — an admin putting a misplaced copy back.
 * Who is asking is not part of the shape; `canRestorePlatformFile` answers
 * that, and the state of the disk with it.
 *
 * Three things make the shape, and all three are about the move rather than
 * about the source's current standing:
 *
 *  - the source is NAMED like a platform file. A nested `roles.yaml`, or a
 *    nested copy of the agent guide, is ordinary content where it sits
 *    (`isPlatformFile` says so, and moving it needs no exception), but it is
 *    still the copy a restore carries back to the root — judging the shape on
 *    `isPlatformFile` would skip the exception for exactly the two files the
 *    root can lose;
 *  - the source is not the root's own copy, which is the copy a restore puts
 *    back, never the one it takes out;
 *  - the destination is a required location for that same name, so the file
 *    lands under the name the platform reads rather than beside it.
 */
export function isPlatformRestoreShape(
  repoRelativeSource: string,
  repoRelativeDestination: string,
): boolean {
  if (hasTraversal(repoRelativeSource)) return false;
  const name = baseName(repoRelativeSource);
  if (!platformFiles().has(name)) return false;
  if (isRootPlatformFile(repoRelativeSource)) return false;
  const target = platformRestoreDestination(repoRelativeDestination);
  return target !== null && target.name === name;
}
