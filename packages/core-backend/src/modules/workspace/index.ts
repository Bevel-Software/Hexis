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
 * Document text extraction: the content-hash cache wrap, the extractor
 * contract it runs extractions through, and the one extractor — a pooled
 * worker under a budget per file. The composition root wires the product's
 * pair through this surface; a suite that registers the workspace tools
 * builds its own the same way.
 */
export { DocExtractService } from './file-readers/doc-extract.service.js';
export type { IDocumentExtractor } from './file-readers/document-extractor.contract.js';
export { WorkerDocumentExtractor } from './file-readers/extract-in-worker.js';
// Reached by other modules; exported here so they stop importing the files.
export { isTextBytes } from './file-readers/text-reader.js';
export { isUntouchedStarterPage, knowledgeFolderIsNew } from './first-run.js';
export type { FirstRunStarter, FirstRunStarterSource, MayRead } from './first-run.js';
export type { WorkspaceService } from './workspace.service.js';
export { sessionIdInputOf } from './workspace.tools.js';
export type { ReadForTool } from './workspace.tools.js';
