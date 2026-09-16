import { reservedRootDirNames } from './kb-layout.js';

/**
 * The files the platform reads as configuration, not content. Each one only
 * works where it is: `access.md` governs the folder it sits in, and
 * `roles.yaml`, `.bevelignore` and `AGENTS.md` are read from the repository
 * root. Moving one changes what the platform enforces, so moves refuse them.
 */
export const PLATFORM_FILE_NAMES: readonly string[] = Object.freeze([
  'access.md',
  'roles.yaml',
  '.bevelignore',
  'AGENTS.md',
]);

const PLATFORM_FILE_KEYS = new Set(PLATFORM_FILE_NAMES.map((n) => n.toLowerCase()));

const baseName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
};

/** Whether `pathOrName` (a bare name or any path) names a platform file. Case-insensitive. */
export function isPlatformFile(pathOrName: string): boolean {
  return PLATFORM_FILE_KEYS.has(baseName(pathOrName).toLowerCase());
}

/** The one sentence every surface refuses a platform-file move with. */
export function platformFileRefusal(pathOrName: string): string {
  return `${baseName(pathOrName)} is a platform file and stays in its folder.`;
}

/**
 * Whether `repoRelativeDir` is a folder the platform owns rather than content:
 * the repository root itself, or one of its reserved top-level folders
 * (`KnowledgeBase/`, `Skills/`, `Plugins/`, `Data/`, …). Deleting or moving
 * one takes a whole section of the knowledge base with it.
 */
export function isPlatformFolder(repoRelativeDir: string): boolean {
  const norm = repoRelativeDir.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (norm === '') return true;
  return !norm.includes('/') && reservedRootDirNames().has(norm);
}

/** The sentence a delete or move of a platform folder is refused with. */
export function platformFolderRefusal(repoRelativeDir: string): string {
  const norm = repoRelativeDir.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  return norm === ''
    ? 'The repository root is a platform folder and cannot be moved or deleted.'
    : `${norm}/ is a platform folder and cannot be moved or deleted.`;
}
