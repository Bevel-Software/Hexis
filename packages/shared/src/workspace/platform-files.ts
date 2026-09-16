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
