import { createHash, type Hash } from 'node:crypto';

/**
 * The id git gives a blob: the repository's hash over `blob <size>\0` and the
 * bytes, exactly what `git hash-object` computes. The hash is SHA-1, or SHA-256
 * in a repository made with `--object-format=sha256`. The server's one way to
 * compute a blob id without asking git.
 */
export type GitObjectFormat = 'sha1' | 'sha256';

/**
 * A hash primed for a blob of `size` bytes: fed exactly those bytes, in order
 * and in any number of parts, its hex digest is their blob id. For bytes read
 * in parts, such as a file too large to hold whole.
 */
export function gitBlobHash(size: number, format: GitObjectFormat = 'sha1'): Hash {
  return createHash(format).update(`blob ${size}\0`);
}

/** The blob id of `bytes`, held whole. */
export function gitBlobSha(bytes: Buffer, format: GitObjectFormat = 'sha1'): string {
  return gitBlobHash(bytes.length, format).update(bytes).digest('hex');
}

/** The object format `objectId` was made with, told by its length: 64 hex digits for SHA-256, else SHA-1. */
export function objectFormatOf(objectId: string): GitObjectFormat {
  return objectId.length === 64 ? 'sha256' : 'sha1';
}
