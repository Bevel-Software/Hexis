import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PERSONAL_PLUGIN_PREFIX,
  PLUGIN_MANIFEST_FILE,
  isPluginIdentifier,
  pluginDisplayNameOf,
  pluginManifestName,
} from '@bevel-software/platform-shared';
import type { AuthUser } from '@bevel-software/platform-shared';
import { PushNeedsAgentResolutionError } from '../../shared/domain-errors.js';
import { walkFiles } from '../../shared/fs-walk.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import {
  PLUGIN_TOKEN_PREFIX,
  canonicalPluginToken,
  hasAccessFrontmatterExtension,
  parsePluginPrincipalKey,
} from '../access-model/access-grammar.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { PluginSource } from './discovery/plugin-source.js';
import { linksWorkspaceId } from './plugin-links.js';

export class PluginRenameError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'PluginRenameError';
  }
}

/** The one commit the rename lands as — a scoped batch, pushed. */
export interface RenameCommitDriver {
  commitChanges(workspaceId: string, user: AuthUser, summary: string, onlyPaths: string[]): Promise<unknown>;
}

export interface RenameResult {
  name: string;
  displayName: string;
  /** Repo-relative files whose grants were rewritten, for the response and the log. */
  rewritten: string[];
}

/**
 * Renaming a plugin — its identifier, its display name, or both.
 *
 * The identifier (the manifest's `name`) IS the plugin: the marketplace
 * publishes it, the URLs key on it, and every grant of `plugin/<name>/<verb>`
 * spells it. Changing it is therefore a rename of a PRINCIPAL, and a
 * principal that is renamed in one file and not another is two principals,
 * one of which nobody is a member of. So the rename is one commit: the
 * manifest, plus every access entry in the knowledge base that names the old
 * identifier, rewritten to the new one. Membership does not change — the
 * same people hold the same verbs through the new spelling — but the caller
 * still needs write on each file the commit touches: the protected-branch
 * gate checks every path, and a rename that lands in some files and is
 * refused in others is the split it exists to prevent. The refusal names the
 * files, so the manager can ask their editors or an admin.
 *
 * The display name is free text with no consequences: the manifest changes,
 * nothing else does.
 */
export class PluginRenameService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly commits: RenameCommitDriver,
    private readonly accessControl: IAccessControl,
    private readonly source: PluginSource,
    private readonly kbDirName: string,
    private readonly events?: {
      emit(event: { kind: 'fs-tree-changed'; workspaceId: string; branch: string }): void;
    },
    private readonly onChanged?: () => void,
  ) {}

  private noteChanged(wsId: string): void {
    noteChangedFor(this.accessControl, this.events, this.onChanged, wsId);
  }

  /** The READ phase must have seen everything it needed; a hole refuses the rename before any write. */
  private assertComplete(unreadable: string[]): void {
    if (unreadable.length === 0) return;
    throw new PluginRenameError(
      `Some of the knowledge base could not be read (${unreadable.join(', ')}), so the rename cannot be checked against every plugin and grant. Try again, or ask an admin.`,
      503,
      { kind: 'incomplete-discovery', unreadable },
    );
  }

  async rename(
    user: AuthUser,
    current: string,
    patch: { name?: unknown; displayName?: unknown },
  ): Promise<RenameResult> {
    const wsId = linksWorkspaceId();
    const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);
    const { plugins, unreadable } = await this.source.discover(kbRoot);
    // Three phases: READ everything, DECIDE, then WRITE. Nothing about the
    // tree — not even that part of it could not be read — reaches a caller
    // before they are known to manage the plugin they name.
    const plugin = plugins.find((p) => p.name === current.trim() && !p.personal && p.exists);
    // Fail closed, like every plugin surface: unknown and not-yours answer alike.
    if (!plugin || !(await this.accessControl.canWrite(wsId, user.email, `${plugin.folder}/access.md`))) {
      throw new PluginRenameError('Unknown plugin', 404, { kind: 'unknown-plugin' });
    }
    if (!plugin.linksAreManaged) {
      throw new PluginRenameError(
        `${plugin.name} is read from an external plugin format; rename it in that repository.`,
        409,
        { kind: 'read-only' },
      );
    }
    // A rename claims a name against EVERY plugin there is. A listing with a
    // hole in it — a folder or manifest that exists but could not be read —
    // is not that set: the name could belong to what was not seen, and two
    // plugins would answer to it once it is. Fail closed; nothing is written.
    this.assertComplete(unreadable);

    const nextName = patch.name === undefined ? plugin.name : String(patch.name).trim();
    // The rules govern a NEW identifier only. The current one is whatever the
    // manifest says — a hand-written name that predates a rule (a reserved
    // prefix, say) must not block a display-name change, and cannot be
    // "fixed" by a rename that keeps it.
    const identifierChanges = nextName !== plugin.name;
    if (identifierChanges && !isPluginIdentifier(nextName)) {
      throw new PluginRenameError(
        'A plugin identifier is lowercase kebab-case: letters, digits and single hyphens, like "sales-team".',
        422,
        { kind: 'bad-name' },
      );
    }
    if (identifierChanges && nextName.startsWith(PERSONAL_PLUGIN_PREFIX)) {
      throw new PluginRenameError(
        `The "${PERSONAL_PLUGIN_PREFIX}" namespace is reserved for personal folders. Pick another identifier.`,
        422,
        { kind: 'bad-name' },
      );
    }
    // Taken by SLUG, not by spelling: a bundle may declare a name that is not
    // an identifier, and the marketplace folds every name to its slug — a
    // collision there drops one of the two from the catalog.
    if (identifierChanges && plugins.some((p) => p !== plugin && pluginManifestName(p.name) === nextName)) {
      throw new PluginRenameError(`A plugin named "${nextName}" already exists.`, 409, { kind: 'name-taken' });
    }
    const folderName = path.posix.basename(plugin.folder);
    const nextDisplay =
      patch.displayName === undefined ? plugin.displayName : String(patch.displayName).trim();

    // The manifest, with everything else in it kept.
    const manifest: Record<string, unknown> = { ...(plugin.manifest ?? {}), name: nextName };
    if (nextDisplay && nextDisplay !== folderName) manifest.displayName = nextDisplay;
    else delete manifest.displayName;
    const manifestRel = `${this.kbDirName}/${plugin.folder}/${PLUGIN_MANIFEST_FILE}`;
    const writes: { rel: string; text: string; before: string | null }[] = [
      { rel: manifestRel, text: `${JSON.stringify(manifest, null, 2)}\n`, before: plugin.manifestText },
    ];

    if (identifierChanges) {
      // Every access entry in the knowledge base that names the old
      // principal — in a folder's access.md or in the own frontmatter of any
      // file kind the resolver reads grants from (`.md`, `.tool`, whatever
      // an overlay registered). STRICT walk: a folder that could not be
      // listed would leave the old spelling live in it, and a principal
      // renamed in some files and not others is two principals.
      // A file the walk listed but that cannot be opened is the same hole as
      // a folder that cannot be listed: the grant it may hold would keep the
      // old spelling. Every such file is collected, then refused together.
      const unopened: string[] = [];
      for (const rel of await walkFiles(kbRoot, hasAccessFrontmatterExtension, { strict: true })) {
        const abs = path.join(kbRoot, rel);
        let before: string;
        try {
          before = await fs.readFile(abs, 'utf-8');
        } catch {
          unopened.push(rel);
          continue;
        }
        const after = renamePluginPrincipalInText(before, plugin.name, nextName);
        if (after !== before) writes.push({ rel: `${this.kbDirName}/${rel}`, text: after, before });
      }
      this.assertComplete(unopened);
      const denied: string[] = [];
      for (const w of writes.slice(1)) {
        const repoRel = w.rel.slice(this.kbDirName.length + 1);
        if (!(await this.accessControl.canWrite(wsId, user.email, repoRel))) denied.push(repoRel);
      }
      if (denied.length > 0) {
        throw new PluginRenameError(
          `Renaming ${plugin.name} would rewrite grants in files you can't edit: ${denied.join(', ')}. Ask their editors, or an admin.`,
          409,
          { kind: 'needs-write', files: denied },
        );
      }
    }

    // Writes and commit share ONE failure envelope: whichever of them fails,
    // the working tree goes back to what origin has — a half-written batch
    // is as much a split principal as a refused commit.
    try {
      for (const w of writes) await this.workspaceService.writeFile(wsId, w.rel, w.text);
      const summary = identifierChanges
        ? `Rename plugin ${plugin.name} to ${nextName}`
        : `Rename plugin ${plugin.name}: display name`;
      await this.commits.commitChanges(
        wsId,
        user,
        summary,
        writes.map((w) => w.rel),
      );
    } catch (err) {
      // One failure is NOT a failed commit: the commit landed locally and only
      // the push did not (the typed hand-off the workflow throws). Restoring
      // the old bytes then would stack an uncommitted inverse of a real
      // commit; the recovery flow owns that state, so it is left alone — and
      // since the tree DID change, every cache keyed on the old identity is
      // dropped before the error goes up, exactly as on success.
      if (err instanceof PushNeedsAgentResolutionError) {
        this.noteChanged(wsId);
      } else {
        for (const w of writes) {
          if (w.before !== null) await this.workspaceService.writeFile(wsId, w.rel, w.before).catch(() => undefined);
        }
      }
      throw err;
    }
    this.noteChanged(wsId);
    return {
      name: nextName,
      displayName: pluginDisplayNameOf(manifest, folderName),
      rewritten: writes.slice(1).map((w) => w.rel.slice(this.kbDirName.length + 1)),
    };
  }
}

/**
 * The tree changed: drop the resolver's model and the plugin caches, and
 * tell every session. The ONE place this happens, for the landed commit and
 * for the committed-but-unpushed one alike.
 */
function noteChangedFor(
  accessControl: IAccessControl,
  events: PluginRenameService['events'],
  onChanged: (() => void) | undefined,
  wsId: string,
): void {
  accessControl.invalidate(wsId);
  events?.emit({ kind: 'fs-tree-changed', workspaceId: wsId, branch: linksWorkspaceIdBranch() });
  onChanged?.();
}

/**
 * Every access entry line naming `plugin/<old>/<verb>` — in ANY spelling the
 * parser accepts — rewritten to `plugin/<next>/<verb>`, the rest of the
 * line (indent, `- `, a `deny` prefix, the line ending) kept. Lines that are
 * not such an entry are untouched, so the file's own formatting survives.
 */
export function renamePluginPrincipalInText(text: string, oldName: string, nextName: string): string {
  const oldSlug = pluginManifestName(oldName);
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*-\s+(?:deny\s+)?)(\S.*?)(\s*)$/i.exec(line);
      if (!m) return line;
      const key = canonicalPluginToken(m[2]!);
      const parsed = key === null ? null : parsePluginPrincipalKey(key);
      if (!parsed || parsed.slug !== oldSlug) return line;
      return `${m[1]}${PLUGIN_TOKEN_PREFIX}${nextName}/${parsed.verb}${m[3]}`;
    })
    .join('\n');
}

function linksWorkspaceIdBranch(): string {
  // The default branch's workspace id IS its encoded branch name.
  return decodeURIComponent(linksWorkspaceId());
}
