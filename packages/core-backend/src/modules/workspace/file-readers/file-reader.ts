/**
 * The FileReader contract: ONE interface every read-path consumer goes
 * through, with per-extension implementations picked by a single registry
 * lookup — the same shape as the frontend's renderer registry.
 *
 * Adding a file format is ONE new reader entry in `createFileReaderRegistry`
 * (file-reader.registry.ts). The three consumers — `read_file`, `grep` and the
 * write-refusal in workspace.tools.ts — dispatch through `readerFor` and never
 * branch on extensions themselves.
 */
import { fileExtension } from './doc-extract.types.js';

/**
 * What reading a file produces, before the tool layer shapes it for MCP:
 * text (the honest `[extracted text of …]` marker is ALREADY prepended for
 * extractions, so line numbers match between read_file and grep), an image
 * payload (the tool layer wraps it in the `McpImageResult` sentinel), or a
 * refusal — legacy formats, oversized images, unreadable binary, corrupt
 * documents — whose message is returned as the file's text content.
 */
export type ReadResult =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: string; mimeType: string; note: string }
  | { kind: 'refusal'; message: string };

/** A per-format file reader. Register implementations in `createFileReaderRegistry`. */
export interface FileReader {
  /** The extensions this reader owns — lowercase, with the dot. Empty for the default (fallback) reader. */
  readonly extensions: readonly string[];
  /** Read `bytes` (read at `path`) into what the read tools return. Must not throw for bad file content. */
  read(bytes: Buffer, path: string): Promise<ReadResult>;
  /**
   * Text `grep` may search, or null when there is nothing (cheaply) searchable.
   * Default readers: the decoded text content (TextReader; null on NUL bytes) /
   * the CACHED extraction (DocumentReader — cold extraction is grep's call,
   * under its per-walk budget) / absent = never greppable (ImageReader).
   */
  greppableText?(bytes: Buffer, path: string): Promise<string | null>;
  /** May the agent TEXT-editing tools (write_file/write_files/edit_file) touch this file? */
  readonly textEditable: boolean;
}

/**
 * Extension → reader, with a default fallback (the text reader). Built once
 * per deployment by `createFileReaderRegistry`; `readerFor` is the ONE lookup
 * every consumer routes through.
 */
export class FileReaderRegistry {
  private readonly byExtension = new Map<string, FileReader>();

  constructor(
    readers: readonly FileReader[],
    private readonly fallback: FileReader,
  ) {
    for (const reader of readers) {
      for (const ext of reader.extensions) this.byExtension.set(ext, reader);
    }
  }

  /** The reader owning `path`'s extension (lowercased by `fileExtension`), or the fallback. */
  readerFor(path: string): FileReader {
    return this.byExtension.get(fileExtension(path)) ?? this.fallback;
  }
}
