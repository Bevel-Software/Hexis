import path from 'node:path';
import fs from 'node:fs/promises';
import {
  WalkError,
  isAbsence,
  isSkippedEntry,
  type EntryStat,
  type IFsProbe,
  type IgnoreRules,
  type ITreeWalker,
  type TreeWalkOptions,
  type WalkListener,
  type WalkResult,
  type WalkedDir,
  type WalkedEntry,
} from '../../shared/fs.contract.js';
import { comparePathComponents } from '../../shared/path-order.js';
import { BevelIgnoreStack } from './bevel-ignore.js';

/**
 * The one implementation of {@link ITreeWalker} and {@link IFsProbe}, over
 * node's filesystem. Stateless: the composition root makes one and hands it
 * to every module that reads the disk. See `shared/fs.contract.ts` for what
 * the walk promises; this file only keeps those promises.
 */
export class NodeFs implements ITreeWalker, IFsProbe {
  // ── ITreeWalker ───────────────────────────────────────────────────────────

  async walk(root: string, options: TreeWalkOptions, listeners: readonly WalkListener[]): Promise<WalkResult> {
    const { skip, ignore = false, leaf, until, unreadable = 'hole' } = options;
    const holes: string[] = [];

    const visit = async (abs: string, rel: string, inherited: IgnoreRules): Promise<void> => {
      if (until?.()) return;
      let raw: WalkedEntry[];
      let rules: IgnoreRules;
      // Only the DISK's failures are holes: the listing and the folder's own
      // rules. A reader's callback that throws is the reader's error, and
      // propagates untouched like every other listener error.
      try {
        const listed = await this.listDir(abs);
        // The root: a checkout without this tree, an empty walk. Deeper: a
        // folder that vanished between listing and visiting — not a hole.
        if (listed === null) return;
        raw = listed;
        // A folder whose own `.bevelignore` is there but cannot be read is as
        // much a hole as one that cannot be listed: its rules are unknown, so
        // nothing in it can be judged. (No file is no rules, never an error.)
        rules = ignore ? await inherited.extendedWith(abs) : inherited;
      } catch (err) {
        if (unreadable === 'throw') throw err;
        holes.push(rel);
        for (const l of listeners) await l.onHole?.(rel, err);
        return;
      }
      const seen = raw.filter((e) => !skip?.(e));
      const isEntry = (e: WalkedEntry) => e.isDirectory() || e.isFile();
      const listed = seen.filter(isEntry);
      // The rules apply to everything that is there — a link a rule names is as hidden as a file.
      const visible = ignore ? seen.filter((e) => !rules.isIgnored(path.join(abs, e.name), e.isDirectory())) : seen;
      const entries = visible.filter(isEntry);
      const dir: WalkedDir = { rel, abs, listed, ignore: rules };
      for (const l of listeners) await l.onDir?.(rel, entries, dir);
      if (leaf?.(dir, entries)) return;
      for (const entry of visible) {
        if (until?.()) return;
        if (!isEntry(entry)) {
          for (const l of listeners) await l.onOther?.(rel, entry);
        } else if (entry.isDirectory()) {
          await visit(path.join(abs, entry.name), rel ? `${rel}/${entry.name}` : entry.name, rules);
        } else {
          for (const l of listeners) await l.onFile?.(rel, entry.name);
        }
      }
    };

    await visit(root, '', typeof ignore === 'object' ? ignore : BevelIgnoreStack.empty());
    return { holes };
  }

  walkKb(root: string, listeners: readonly WalkListener[], options: Omit<TreeWalkOptions, 'skip'> = {}): Promise<WalkResult> {
    return this.walk(root, { ...options, skip: (e) => isSkippedEntry(e.name) }, listeners);
  }

  async walkFiles(root: string, match: (basename: string) => boolean, opts: { strict?: boolean } = {}): Promise<string[]> {
    // Walk order IS component order over the paths: a folder's entries come
    // sorted, and a folder's files are visited before its sibling's.
    const out: string[] = [];
    await this.walkKb(root, [
      {
        onFile(dir, name) {
          if (match(name)) out.push(dir ? `${dir}/${name}` : name);
        },
        onHole(rel, err) {
          if (opts.strict) throw new WalkError(rel, err);
        },
      },
    ]);
    return out;
  }

  // ── IFsProbe ──────────────────────────────────────────────────────────────

  async exists(p: string): Promise<boolean> {
    return (await this.lstatOrNull(p)) !== null;
  }

  statOrNull(p: string): Promise<EntryStat | null> {
    return fs.stat(p).catch((err: unknown) => (isAbsence(err) ? null : Promise.reject(err)));
  }

  lstatOrNull(p: string): Promise<EntryStat | null> {
    return fs.lstat(p).catch((err: unknown) => (isAbsence(err) ? null : Promise.reject(err)));
  }

  async isDirectory(p: string): Promise<boolean> {
    return (await this.lstatOrNull(p))?.isDirectory() ?? false;
  }

  async listDir(p: string): Promise<WalkedEntry[] | null> {
    let raw: import('node:fs').Dirent[];
    try {
      raw = await fs.readdir(p, { withFileTypes: true });
    } catch (err) {
      if (isAbsence(err)) return null;
      throw err;
    }
    return raw.sort((a, b) => comparePathComponents(a.name, b.name));
  }

  async readTextFile(p: string): Promise<string> {
    return fs.readFile(p, 'utf-8');
  }

  async readJsonObject(p: string): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      text = await this.readTextFile(p);
    } catch (err) {
      if (isAbsence(err)) return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  }
}
