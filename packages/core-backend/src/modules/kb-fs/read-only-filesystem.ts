import {
  LocalFilesystem,
  type CopyOptions,
  type FileContent,
  type RemoveOptions,
  type WriteOptions,
} from '@mastra/core/workspace';

/**
 * A `LocalFilesystem` that permits reads but refuses every mutating operation.
 * Mastra hands the agent the workspace filesystem's tools (write_file /
 * edit_file / delete / mkdir / move / copy); for consumer personas we hand it
 * this instead so those tools exist but fail closed — the agent can read and
 * explore the ontology, but cannot change it.
 *
 * The architect agent keeps the lock-aware `LockingFilesystem` (which commits +
 * pushes); consumer agents get no write path at all.
 */
export class ReadOnlyFilesystem extends LocalFilesystem {
  private static deny(op: string): never {
    throw new Error(
      `This assistant is read-only — "${op}" is not allowed. ` +
        `It can read and analyze the knowledge base, but cannot modify it.`,
    );
  }

  override async writeFile(_path: string, _content: FileContent, _options?: WriteOptions): Promise<void> {
    ReadOnlyFilesystem.deny('write_file');
  }

  override async appendFile(_path: string, _content: FileContent): Promise<void> {
    ReadOnlyFilesystem.deny('append_file');
  }

  override async deleteFile(_path: string, _options?: RemoveOptions): Promise<void> {
    ReadOnlyFilesystem.deny('delete_file');
  }

  override async copyFile(_src: string, _dest: string, _options?: CopyOptions): Promise<void> {
    ReadOnlyFilesystem.deny('copy_file');
  }

  override async moveFile(_src: string, _dest: string, _options?: CopyOptions): Promise<void> {
    ReadOnlyFilesystem.deny('move_file');
  }

  override async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {
    ReadOnlyFilesystem.deny('mkdir');
  }

  override async rmdir(_path: string, _options?: RemoveOptions): Promise<void> {
    ReadOnlyFilesystem.deny('rmdir');
  }
}
