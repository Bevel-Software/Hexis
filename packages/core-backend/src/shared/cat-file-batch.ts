import { assertOneSpecPerLine, type IGitRunner } from './git.contract.js';

/**
 * What one spec of a batched read came back as: a blob's bytes and object
 * id, nothing at that spec, or an object that is not a file (a directory,
 * say). The last two are told apart on purpose: for the access model at a
 * commit, a path that is there but is not a file is not "absent", it is
 * config the model cannot be read from.
 */
export type CatFileBytes =
  | { kind: 'blob'; bytes: Buffer; objectId: string }
  | { kind: 'missing' }
  | { kind: 'non-blob'; type: string };

/**
 * Read many objects from a git repo in ONE `git cat-file --batch` process:
 * the one reader of that protocol, for the access service's batched reads
 * and for a file's bytes at a ref (`GitService`).
 * `specs` are `<ref>:<path>` lines or object ids; the result array is
 * index-aligned with them. Output protocol per request:
 * `<oid> <type> <size>\n<size bytes>\n`, or `<spec> missing\n` (the spec may
 * itself contain spaces, hence the endsWith checks).
 *
 * A blob's bytes are a view onto the one reply: a caller that keeps anything
 * of them past its own use copies what it keeps.
 */
export async function catFileBatchBytes(runner: IGitRunner, repoDir: string, specs: string[]): Promise<CatFileBytes[]> {
  // Bytes, not text: every `<size>` in the header counts bytes, and the walk
  // below has to step by that count through content that is not all ASCII.
  // One spec per LINE is the protocol, and this walk depends on getting back
  // exactly as many answers as it sent: a spec carrying a line break would
  // insert an extra answer and shift every result after it, so each directory
  // would be handed the NEXT one's `access.md`. Paths are refused a control
  // character at the normaliser; this is the fence at the protocol.
  assertOneSpecPerLine(specs);
  const { stdout: out } = await runner.run(repoDir, ['cat-file', '--batch'], {
    input: `${specs.join('\n')}\n`,
    encoding: 'buffer',
  });
  const results: CatFileBytes[] = [];
  let off = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = out.indexOf(0x0a, off);
    if (nl < 0) throw new Error('unexpected end of git cat-file output');
    const header = out.subarray(off, nl).toString('utf-8');
    off = nl + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      results.push({ kind: 'missing' });
      continue;
    }
    const parts = header.split(' ');
    const size = Number(parts[2]);
    if (parts.length !== 3 || !Number.isInteger(size) || size < 0) {
      throw new Error(`unexpected git cat-file header: ${header}`);
    }
    // A non-blob (a directory path resolves to a tree) is reported as such,
    // and its payload still has to be skipped to stay aligned.
    results.push(
      parts[1] === 'blob'
        ? { kind: 'blob', bytes: out.subarray(off, off + size), objectId: parts[0]! }
        : { kind: 'non-blob', type: parts[1]! },
    );
    off += size + 1; // payload + trailing LF
  }
  return results;
}
