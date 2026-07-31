import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Global store for `call_tool_chain` spill files. When a tool-chain result is too
 * large to return inline, the full JSON is parked here — OUTSIDE any workspace,
 * in a single shared directory (`config.spillRoot`, sibling of `workspacesRoot`) —
 * so any agent, in-process or external over MCP, can read it back regardless of
 * which branch's workspace (if any) it is operating on.
 *
 * Read-back is via the regular `read_file` tool: a spill is addressed by a
 * reserved, workspace-independent ref (`__tool_chain_spill__/<id>.json`) that
 * `read_file` recognises and resolves here instead of against a workspace
 * filesystem. Files are ephemeral and never committed; each write best-effort
 * prunes entries older than the TTL so the directory can't grow without bound.
 */
const SPILL_PREFIX = '__tool_chain_spill__/';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const ID_RE = /^[A-Za-z0-9._-]+$/; // no path separators — keeps reads inside the root

export class SpillStore {
  constructor(private readonly root: string) {}

  /** Is this `read_file` path a spill ref rather than a workspace-relative path? */
  isSpillRef(p: string): boolean {
    return p.startsWith(SPILL_PREFIX);
  }

  /**
   * Park `content` and return the ref to read it back with. The ref is what an
   * agent passes to `read_file` (its `branch` is ignored for spill reads).
   */
  async write(content: string): Promise<{ ref: string; bytes: number }> {
    await fs.mkdir(this.root, { recursive: true });
    void this.gc();
    const id = `tool-chain-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomSuffix()}.json`;
    await fs.writeFile(path.join(this.root, id), content, 'utf8');
    return { ref: SPILL_PREFIX + id, bytes: Buffer.byteLength(content, 'utf8') };
  }

  /**
   * Read a spill back by ref, optionally a byte window `[offset, offset+limit)`.
   * The window is range-read straight off disk (`createReadStream` with
   * `start`/`end`), so a multi-MB spill never lands in memory just to return a
   * slice. Throws if the ref is malformed or the spill has been GC'd.
   */
  async read(ref: string, offset?: number, limit?: number): Promise<string> {
    const id = ref.slice(SPILL_PREFIX.length);
    if (!ID_RE.test(id)) throw new Error(`Invalid spill ref "${ref}".`);
    if (typeof limit === 'number' && limit <= 0) return '';
    const start = typeof offset === 'number' && offset > 0 ? offset : 0;
    // `end` is INCLUSIVE in createReadStream, so [start, start+limit).
    const end = typeof limit === 'number' ? start + limit - 1 : undefined;
    const filePath = path.join(this.root, id);
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = createReadStream(filePath, end !== undefined ? { start, end } : { start });
      stream.on('data', (c) => chunks.push(c as Buffer));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  }

  /** Best-effort prune of spills older than the TTL. Never throws. */
  private async gc(): Promise<void> {
    try {
      const now = Date.now();
      const names = await fs.readdir(this.root);
      await Promise.all(
        names.map(async (name) => {
          try {
            const stat = await fs.stat(path.join(this.root, name));
            if (now - stat.mtimeMs > TTL_MS) await fs.rm(path.join(this.root, name), { force: true });
          } catch {
            // file vanished mid-sweep / unreadable — ignore
          }
        }),
      );
    } catch {
      // root not yet created or unreadable — nothing to prune
    }
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
