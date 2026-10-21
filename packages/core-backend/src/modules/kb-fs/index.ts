/**
 * What the kb-fs module offers the other modules. The filesystem and the
 * locks are wired by the composition root; a module that writes through the
 * workspace needs only the shape of the gate every write passes first.
 */
export type { WriteValidator } from './locking-filesystem.js';
export { WorkspaceMutex, WorkspaceIdMutex } from './mutex.js';
export { readRefSha, readRevSha, type RefFileAnswer } from './ref-files.js';
export { gitDirOf, readGitfile } from './git-dir.js';
