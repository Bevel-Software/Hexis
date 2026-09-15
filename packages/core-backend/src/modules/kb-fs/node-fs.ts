import path from 'node:path';
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import {
  WalkError,
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
import { isAbsence } from './fs-errors.js';

/** The knowledge-base walk's skip list: dot-entries (`.git`, a parked delete) and vendored dependencies. */
export function isSkippedEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

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
      let raw: import('node:fs').Dirent[];
      let rules: IgnoreRules;
      try {
        raw = await fs.readdir(abs, { withFileTypes: true });
        // A folder whose own `.bevelignore` is there but cannot be read is as
        // much a hole as one that cannot be listed: its rules are unknown, so
        // nothing in it can be judged. (No file is no rules, never an error.)
        rules = ignore ? await inherited.extendedWith(abs) : inherited;
      } catch (err) {
        if (isAbsence(err)) {
          // The root: a checkout without this tree, an empty walk. Deeper: a
          // folder that vanished between listing and visiting — not a hole.
          return;
        }
        if (unreadable === 'throw') throw err;
        holes.push(rel);
        for (const l of listeners) await l.onHole?.(rel, err);
        return;
      }
      const seen = raw.filter((e) => !skip?.(e)).sort((a, b) => comparePathComponents(a.name, b.name));
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
    return out.sort();
  }

  // ── IFsProbe ──────────────────────────────────────────────────────────────

  isAbsence(err: unknown): boolean {
    return isAbsence(err);
  }

  async exists(p: string): Promise<boolean> {
    return (await this.lstatOrNull(p)) !== null;
  }

  statOrNull(p: string): Promise<Stats | null> {
    return fs.stat(p).catch((err: unknown) => (isAbsence(err) ? null : Promise.reject(err)));
  }

  lstatOrNull(p: string): Promise<Stats | null> {
    return fs.lstat(p).catch((err: unknown) => (isAbsence(err) ? null : Promise.reject(err)));
  }

  async isDirectory(p: string): Promise<boolean> {
    return (await this.lstatOrNull(p))?.isDirectory() ?? false;
  }

  async readJsonObject(p: string): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      text = await fs.readFile(p, 'utf-8');
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
