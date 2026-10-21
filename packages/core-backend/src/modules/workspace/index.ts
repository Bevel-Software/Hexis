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
// The agent-access gate: what a module's agent tools take to tell the
// deployment's hooks of a read or a write, and the session input they declare.
export {
  assertAgentWriteAllowed,
  notifyAgentRead,
  SESSION_ID_DESCRIPTION,
  SESSION_ID_INPUT,
  ToolDescriptionNotes,
  type AgentAccessGate,
} from './agent-access.gate.js';
export { SpillStore } from './spill-store.js';
/**
 * Document text extraction: the content-hash cache wrap, and the extractor
 * that runs each extraction in a pooled worker under its budget. A suite that
 * registers the workspace tools builds its own pair; the product's is wired
 * by the composition root.
 */
export { DocExtractService } from './file-readers/doc-extract.service.js';
export { WorkerDocumentExtractor } from './file-readers/extract-in-worker.js';
