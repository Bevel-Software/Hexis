import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

const IGNORE_FILENAME = '.bevelignore';

/** One .bevelignore file's rules, scoped to the directory it lives in. */
interface IgnoreLayer {
  /** Absolute path of the directory where the .bevelignore lives. */
  readonly root: string;
  readonly matcher: Ignore;
}

/**
 * A hierarchical stack of `.bevelignore` rule sets.
 *
 * Each `.bevelignore` file applies to paths beneath the directory it lives in,
 * using standard gitignore syntax (negations, `**`, directory-only patterns, anchoring).
 * Deeper files combine with — and can override — rules from shallower files,
 * mirroring how git layers `.gitignore` files.
 */
export class BevelIgnoreStack {
  private constructor(private readonly layers: readonly IgnoreLayer[]) {}

  static empty(): BevelIgnoreStack {
    return new BevelIgnoreStack([]);
  }

  /**
   * Return a new stack that additionally includes a `.bevelignore` from `dir`
   * (if present). If no `.bevelignore` exists in `dir`, returns this stack unchanged.
   */
  async extendedWith(dir: string): Promise<BevelIgnoreStack> {
    const file = path.join(dir, IGNORE_FILENAME);
    let contents: string;
    try {
      contents = await fs.readFile(file, 'utf-8');
    } catch {
      return this;
    }
    const matcher = ignore().add(contents);
    return new BevelIgnoreStack([...this.layers, { root: dir, matcher }]);
  }

  /**
   * Whether the given entry should be hidden from the file tree.
   * @param absolutePath absolute path of the entry
   * @param isDirectory needed because gitignore patterns ending in `/` match directories only
   */
  isIgnored(absolutePath: string, isDirectory: boolean): boolean {
    for (const layer of this.layers) {
      const rel = path.relative(layer.root, absolutePath).replace(/\\/g, '/');
      // Skip entries that aren't under this layer's root (shouldn't happen in normal
      // recursion, but guards against absolute-path quirks on Windows).
      if (!rel || rel.startsWith('..')) continue;
      // Append trailing slash for directories so `foo/`-style rules match correctly.
      const probe = isDirectory ? `${rel}/` : rel;
      if (layer.matcher.ignores(probe)) return true;
    }
    return false;
  }
}
