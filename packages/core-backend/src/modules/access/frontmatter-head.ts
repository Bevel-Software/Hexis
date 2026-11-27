import fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { isFrontmatterFence } from '@bevel-software/platform-shared';

const HEAD_FIRST_READ = 1_024;
const HEAD_LAST_READ = 64 * 1_024;
/** The largest read when a file is read to its end. */
const WHOLE_FILE_READ = 1_024 * 1_024;

/**
 * Finds the start of a file that holds everything its frontmatter can say,
 * from the file's bytes fed in order: its first line when that is no fence
 * (no frontmatter at all), the text through the closing fence when there is
 * one, and the whole file when an opening fence is never closed. Scanned for
 * its frontmatter (`scanFrontmatter`), that start answers exactly as the
 * whole file does, by the same fence rule (`isFrontmatterFence`).
 *
 * One scanner for both places a file is read from, the checkout and a git
 * object, so the two cannot disagree on where a file's frontmatter ends.
 */
class HeadScanner {
  private readonly decoder = new StringDecoder('utf8');
  // What was read, kept as it was decoded and joined once, when answered:
  // each character is scanned once, however long a line runs.
  private readonly pieces: string[] = [];
  private before = 0;
  // The line being read so far, folded (see `foldLine`), or null once it
  // can no longer be a fence.
  private line: string | null = '';
  private first = true;

  /** The head, once `chunk` decides it; null while more of the file is needed. */
  feed(chunk: Buffer): string | null {
    const piece = this.decoder.write(chunk);
    this.pieces.push(piece);
    let from = 0;
    for (let nl = piece.indexOf('\n'); nl !== -1; nl = piece.indexOf('\n', from)) {
      const fence = this.line !== null && isFrontmatterFence(foldLine(this.line, piece.slice(from, nl)));
      // The first line opens a block or there is none; after it, the first
      // fence closes the block.
      if (this.first ? !fence : fence) return this.pieces.join('').slice(0, this.before + nl);
      this.first = false;
      this.line = '';
      from = nl + 1;
    }
    if (this.line !== null) {
      this.line = foldLine(this.line, piece.slice(from));
      if (!'---'.startsWith(this.line.trim())) this.line = null;
    }
    // A first line still unfinished that already cannot be a fence.
    if (this.first && this.line === null) return this.pieces.join('');
    this.before += piece.length;
    return null;
  }

  /** The head of a file that ended undecided: all of it. */
  end(): string {
    return this.pieces.join('') + this.decoder.end();
  }
}

/**
 * The frontmatter head of the file at `file` (see {@link HeadScanner}): a
 * file with no frontmatter costs one small read however long it is.
 */
export async function frontmatterHead(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const scanner = new HeadScanner();
    let position = 0;
    for (let size = HEAD_FIRST_READ; ; size = Math.min(size * 2, HEAD_LAST_READ)) {
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      if (bytesRead === 0) return scanner.end();
      position += bytesRead;
      const head = scanner.feed(chunk.subarray(0, bytesRead));
      if (head !== null) return head;
    }
  } finally {
    await handle.close();
  }
}

/**
 * The frontmatter head of the file at `file`, as {@link frontmatterHead}
 * answers it, read to the file's end: each chunk read goes to `eachChunk` in
 * order, so a caller can hash the whole file in the same pass.
 */
export async function frontmatterHeadOfWholeFile(file: string, eachChunk: (chunk: Buffer) => void): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const scanner = new HeadScanner();
    let head: string | null = null;
    let position = 0;
    for (let size = HEAD_FIRST_READ; ; size = Math.min(size * 2, WHOLE_FILE_READ)) {
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      if (bytesRead === 0) return head ?? scanner.end();
      position += bytesRead;
      const read = chunk.subarray(0, bytesRead);
      eachChunk(read);
      if (head === null) head = scanner.feed(read);
    }
  } finally {
    await handle.close();
  }
}

/**
 * The frontmatter head of a file whose bytes are `bytes` (a git object):
 * what {@link frontmatterHead} answers for a file holding them, decoding no
 * more of them than it reads.
 */
export function frontmatterHeadOfBytes(bytes: Buffer): string {
  const scanner = new HeadScanner();
  let position = 0;
  for (let size = HEAD_FIRST_READ; position < bytes.length; size = Math.min(size * 2, HEAD_LAST_READ)) {
    const head = scanner.feed(bytes.subarray(position, position + size));
    if (head !== null) return head;
    position += size;
  }
  return scanner.end();
}

/**
 * `line` continued by `more`, every run of whitespace folded to one space.
 * Trimmed, it is `---` exactly when the unfolded line is, so it judges a fence
 * as `isFrontmatterFence` does while staying a few characters long.
 */
function foldLine(line: string, more: string): string {
  return `${line}${more}`.replace(/\s+/g, ' ');
}
