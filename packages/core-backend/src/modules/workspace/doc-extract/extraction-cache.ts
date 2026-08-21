import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExtractedDoc } from './doc-extract.types.js';

/**
 * Git BLOB sha of `bytes` — sha1 over `"blob <len>\0" + bytes`, exactly what
 * `git hash-object` computes. Chosen as the cache key because the workspace is
 * a git clone: for a clean tracked file this equals the sha `git ls-files -s`
 * would report, WITHOUT spawning git — and because it is computed from the
 * bytes actually read, it stays correct (it just stops matching the index)
 * when the file is untracked or dirty. One code path, no fallback branch.
 */
export function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Default size bound for the on-disk extraction cache. */
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 512MB

/**
 * On-disk cache of document extractions, keyed by git blob sha (content hash —
 * a re-upload of identical bytes, or the same document on another branch or
 * path, hits the same entry). One JSON file per entry (`<sha>.json` holding
 * the `{ summary, text }`), under a dedicated root that — like the spill
 * store's — sits BESIDE the workspaces root, never inside a workspace and
 * never committed.
 *
 * Bounding: on each write the cache best-effort prunes OLDEST-MTIME entries
 * until the total size fits `maxTotalBytes` (simple LRU-ish eviction; reads
 * don't touch mtime, so it is closer to FIFO — good enough for a cache whose
 * entries are cheap to rebuild). Every filesystem error here is swallowed:
 * the cache is an accelerator, never a reason for a read to fail.
 */
export class DocExtractionCache {
  constructor(
    private readonly root: string,
    private readonly maxTotalBytes: number = DEFAULT_MAX_TOTAL_BYTES,
  ) {}

  /** The cached extraction for `sha`, or undefined on miss/corrupt entry. */
  async get(sha: string): Promise<ExtractedDoc | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.entryPath(sha), 'utf8'));
      if (
        typeof parsed === 'object' && parsed !== null &&
        typeof (parsed as ExtractedDoc).summary === 'string' &&
        typeof (parsed as ExtractedDoc).text === 'string'
      ) {
        return { summary: (parsed as ExtractedDoc).summary, text: (parsed as ExtractedDoc).text };
      }
      return undefined;
    } catch {
      return undefined; // miss, unreadable or corrupt — treated identically
    }
  }

  /** Store an extraction under `sha`; prunes towards the size bound. Never throws. */
  async put(sha: string, doc: ExtractedDoc): Promise<void> {
    try {
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(this.entryPath(sha), JSON.stringify({ summary: doc.summary, text: doc.text }), 'utf8');
      await this.prune();
    } catch {
      // cache write failed — the extraction still returns; next read re-extracts
    }
  }

  private entryPath(sha: string): string {
    return path.join(this.root, `${sha}.json`);
  }

  /** Delete oldest-mtime entries until the total size fits the bound. */
  private async prune(): Promise<void> {
    const entries: Array<{ p: string; size: number; mtime: number }> = [];
    let total = 0;
    for (const name of await fs.readdir(this.root)) {
      try {
        const st = await fs.stat(path.join(this.root, name));
        if (!st.isFile()) continue;
        entries.push({ p: path.join(this.root, name), size: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch {
        // vanished mid-scan — ignore
      }
    }
    if (total <= this.maxTotalBytes) return;
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries) {
      if (total <= this.maxTotalBytes) return;
      await fs.rm(e.p, { force: true });
      total -= e.size;
    }
  }
}
