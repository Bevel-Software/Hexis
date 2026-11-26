/**
 * What the kb-fs module offers the other modules. The filesystem and the
 * locks are wired by the composition root; a module that writes through the
 * workspace needs only the shape of the gate every write passes first.
 */
export type { WriteValidator } from './locking-filesystem.js';
export { WorkspaceMutex, WorkspaceIdMutex } from './mutex.js';
export { readRefSha, readRevSha, type RefFileAnswer } from './ref-files.js';
export { gitDirOf, readGitfile } from './git-dir.js';
export { normalizeWorkspacePath } from './repo-path.js';
export { TMP_REF_PREFIX, assertTmpRefsTaken, isTmpRef, tmpRefReadOnlyRefusal } from './tmp-ref.js';
// Reached by other modules; exported here so they stop importing the files.
export { BevelIgnoreStack } from './bevel-ignore.js';
export { assertValidBranchName, assertValidRelativePath, isBranchAuthoredBy, isOwnSuggestionsBranch } from './branch-name.js';
export { ORIGIN_FETCH_REFSPEC, SAFE_IMPLICIT_FETCH_ARGS, cloneCredentialArgs, cloneCredentialConfigArgs, cloneTrackingConfigArgs, credentialHelperValue } from './clone-config.js';
export type { FileChangeNotifier } from './file-change-notifier.js';
export { GitGuardedFilesystem } from './git-guarded-filesystem.js';
export { LockingFilesystem, MoveLockedError, MoveRacedError } from './locking-filesystem.js';
export { ReadOnlyFilesystem } from './read-only-filesystem.js';
export { normalizeRepositoryAddress, sameRepository } from './remote-url.js';
export { assertInsideRepo, assertKbDirNameFree, assertRepoRootNameFree, assertRepoRootNameFreeArgs, hasControlCharacter, isInsideRepo, normalizePathArgs } from './repo-path.js';
export type { NormalizePathArgsOptions } from './repo-path.js';
