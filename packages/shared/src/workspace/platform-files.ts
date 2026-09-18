import { reservedRootDirNames } from './kb-layout.js';

/**
 * The files the platform reads as configuration, not content. `access.md`
 * governs the folder it sits in and `.bevelignore` layers like `.gitignore`,
 * so both count at any depth; `roles.yaml` and `AGENTS.md` are read from the
 * repository root only, so a nested file of that name is ordinary content.
 * Moving one changes what the platform enforces, so moves refuse them.
 */
export const PLATFORM_FILE_NAMES: readonly string[] = Object.freeze([
  'access.md',
  'roles.yaml',
  '.bevelignore',
  'AGENTS.md',
]);

/** The platform files that are read wherever they sit, not only at the root. */
const PLATFORM_FILES_AT_ANY_DEPTH = new Set(['access.md', '.bevelignore']);

const PLATFORM_FILES = new Set(PLATFORM_FILE_NAMES);

const normalize = (path: string): string => path.replace(/^\.?\/+/, '').replace(/\/+$/, '');

const baseName = (path: string): string => {
  const trimmed = normalize(path);
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
};

/**
 * Whether the repository-relative `repoRelativePath` is a platform file.
 * Exact spelling, as the platform reads it: `Access.md` is content. A caller
 * on a case-insensitive disk passes the path's on-disk spelling.
 */
export function isPlatformFile(repoRelativePath: string): boolean {
  const norm = normalize(repoRelativePath);
  const name = baseName(norm);
  if (!PLATFORM_FILES.has(name)) return false;
  return PLATFORM_FILES_AT_ANY_DEPTH.has(name) || norm === name;
}

/** The one sentence every surface refuses a platform-file move with. */
export function platformFileRefusal(pathOrName: string): string {
  return `${baseName(pathOrName)} is a platform file and stays in its folder.`;
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
  return PLATFORM_FILES.has(normalize(repoRelativePath));
}

/**
 * The place a misplaced platform file is allowed to be put back, when
 * `repoRelativeDestination` names one, and null when it does not.
 *
 * `roles.yaml`, `.bevelignore` and `AGENTS.md` are read from the repository
 * root and nowhere else, so their one required location is the root.
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
  const name = baseName(norm);
  if (!PLATFORM_FILES.has(name)) return null;
  if (name === 'access.md') {
    const slash = norm.lastIndexOf('/');
    return { name, kind: 'folder-without-access-md', dir: slash === -1 ? '' : norm.slice(0, slash) };
  }
  return norm === name ? { name, kind: 'root' } : null;
}
