/**
 * What the workspace module offers the other modules: how a file's bytes are
 * read and told apart — the reader registry `read_file` dispatches on, and
 * the raw content type a file is served with — so a module that serves a
 * file answers exactly as a read of it would. The services are wired by the
 * composition root.
 */
export {
  FileReaderRegistry,
  type FileKind,
  type FileReader,
  type ReadResult,
} from './file-readers/file-reader.js';
export { OCTET_STREAM, rawExtensionOf, rawMimeFor } from './file-readers/raw-mime.js';
/**
 * The knowledge base's one repository, every branch workspace a worktree of
 * it. (Where a checkout's git directory is — its `.git` folder, or the
 * folder its `.git` FILE names — is `kb-fs/git-dir.ts`.)
 */
export {
  KbRepository,
  repositoryDirFor,
  workingCopyShape,
  type WorkingCopyShape,
} from './kb-repository.js';
export type { AddWorktreeOptions, FetchOptions, IKbRepository } from './kb-repository.contract.js';
