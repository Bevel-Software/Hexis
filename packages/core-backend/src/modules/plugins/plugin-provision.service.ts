/**
 * Plugin provisioning — the ONE privileged door for bringing a `Plugins/<name>/`
 * folder into existence, and (via {@link PluginProvisionService.deletePlugin})
 * for taking one back out of it.
 *
 * Creating a plugin is the single operation the access model cannot govern
 * from inside: the folder that will carry the rules does not exist yet, and
 * the root's own rule (`write: Admin`) says no. The old answer was a
 * carve-out inside the generic write gate — every write path could claim an
 * unused name under `Plugins/`, and the gate had to re-derive "is this that
 * one blessed case?" on every check. This service replaces that: the generic
 * gate is uniformly strict again, and the privilege lives here, named,
 * behind its own endpoint.
 *
 * What a provision IS: one exclusive write of the new folder's `access.md`
 * (flag `wx`, so two concurrent creators race for the fs, not for the
 * overwrite), then one SYNCHRONOUS commit+push. Synchronous on purpose — the
 * write gate reads rules at HEAD, so a creation whose access.md were still
 * sitting in the async commit queue would 403 the very next thing its
 * creator does (writing the first skill into it).
 *
 * Two shapes, two templates:
 *
 *   - A NAMED plugin: discoverable by design. The access.md's own frontmatter
 *     reads `everyone` — anyone may open the FILE, see the plugin listed, and
 *     ask to join — while the BODY (the folder's actual rules) names only
 *     the creator under read, write and owner.
 *   - A PERSONAL folder (`personal-<user-id>`): private by design. No
 *     frontmatter grant at all, so nobody else can even see it exists; the
 *     body names its owner. Created lazily (ensure semantics) on the first
 *     personal skill.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_BRANCH,
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  pluginManifestName,
  renderPluginManifest,
  PERSONAL_PLUGIN_PREFIX,
  isPersonalPluginFolder,
  personalPluginFolderName,
  type AuthUser,
} from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { creatorPrincipal } from '../access/creator-access.js';
import { spliceGrant } from '../access/access-splice.js';
import { WorkspaceMutex } from '../workflow/git/mutex.js';

/** Commit machinery the provision rides — the pending-commit pipeline, run inline. */
export interface ProvisionCommitDriver {
  runPendingCommit(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
    opts?: { systemAuthorized?: boolean },
  ): Promise<void>;
}

export interface ProvisionedPlugin {
  /** The folder name under `Plugins/` (not the full path). */
  folder: string;
  /** False when an ensure found the folder already there. */
  created: boolean;
}

/** A refusal the route can pass through: message + HTTP status. */
export class PluginProvisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PluginProvisionError';
  }
}

export class PluginProvisionService {
  /**
   * Serialises creations and deletions by MANIFEST SLUG
   * (`pluginManifestName(name)`). The wx write arbitrates same-path races,
   * but the identity the collision checks defend is the slug: case-variants
   * (`GTM`/`gtm`) and distinct spellings (`Sales Team`/`Sales-Team`) all
   * derive the same key, so no two requests that would publish one manifest
   * name can hold the lock at once.
   */
  private readonly creations = new WorkspaceMutex();

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly commits: ProvisionCommitDriver,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
    private readonly events?: { emit(event: { kind: 'fs-tree-changed'; workspaceId: string; branch: string }): void },
  ) {}

  /**
   * Create `Plugins/<name>/` for `user`. Throws `PluginProvisionError` 422 on a
   * name the filesystem or the model cannot carry, 409 when the name is taken
   * (case-insensitively — the workspaces live on case-insensitive
   * filesystems too, where `GTM` and `gtm` are one folder).
   */
  async createPlugin(user: AuthUser, rawName: string): Promise<ProvisionedPlugin> {
    const name = rawName.trim();
    if (!name) throw new PluginProvisionError('A plugin needs a name.', 422);
    // eslint-disable-next-line no-control-regex -- NUL and control chars are
    // exactly what a filesystem path cannot carry; refusing them here keeps
    // the refusal a 422 instead of the fs layer's 500.
    if (/[/\\\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
      throw new PluginProvisionError(
        'A plugin name can\'t contain / or \\ or control characters, or start with a dot.',
        422,
      );
    }
    // Reserved BY SLUG, which subsumes the folder-name spelling: personal
    // folders publish manifests like any plugin, so "Personal Abc" (slug
    // `personal-abc`) squats the namespace exactly as "personal-abc" would —
    // a name-only check let it through.
    if (pluginManifestName(name).startsWith(PERSONAL_PLUGIN_PREFIX)) {
      // The message names the DERIVED slug: for a spelling like "Personal
      // Abc" the reservation is invisible in the name itself, and a refusal
      // the user can't trace to their input is a refusal they can't fix.
      throw new PluginProvisionError(
        `"${name}" would publish the manifest name "${pluginManifestName(name)}" — ` +
          `the "${PERSONAL_PLUGIN_PREFIX}" namespace is reserved for personal folders. Pick another name.`,
        422,
      );
    }
    // Locked on the manifest SLUG, not the lowercased folder: the slug is the
    // identity the twin check below defends, and two spellings that collide
    // on it ("Sales Team" / "Sales-Team") must take the SAME lock or both
    // pass the check concurrently. Case-variants share a slug too, so this
    // key subsumes the old lowercase one — and deletion (below) derives its
    // key the same way, keeping delete/re-create of one name serialized.
    return this.creations.run(`plugin:${pluginManifestName(name)}`, async () => {
      const existing = await this.existingFolder(name);
      if (existing !== null) {
        throw new PluginProvisionError(`A plugin named "${existing}" already exists.`, 409);
      }
      // Folder uniqueness is not manifest uniqueness: the manifest `name` is
      // a LOSSY slug of the folder (`Sales Team` and `Sales-Team` both
      // become `sales-team`), and it is the identity a conformant client
      // keys plugins on — two folders sharing it would be two plugins one
      // key, with no telling which a client resolves.
      const slugTwin = await this.manifestNameTwin(name);
      if (slugTwin !== null) {
        throw new PluginProvisionError(
          `"${name}" and the existing plugin "${slugTwin}" would share the manifest name ` +
            `"${pluginManifestName(name)}" — pick a more distinct name.`,
          409,
        );
      }
      await this.provision(user, name, pluginAccessMd(user));
      return { folder: name, created: true };
    });
  }

  /**
   * Ensure the caller's personal folder exists — idempotent, keyed to the
   * stable user id. Returns `created: false` when it is already there.
   */
  async ensurePersonalPlugin(user: AuthUser): Promise<ProvisionedPlugin> {
    const folder = personalPluginFolderName(user.id);
    return this.creations.run(`plugin:${pluginManifestName(folder)}`, async () => {
      if ((await this.existingFolder(folder)) !== null) {
        return { folder, created: false };
      }
      try {
        await this.provision(user, folder, personalAccessMd(user));
      } catch (err) {
        // ENSURE semantics even under a race the lock cannot see (another
        // process, a checkout that appeared between check and write): the
        // folder existing is this method's success case, never its error.
        if (err instanceof PluginProvisionError && err.status === 409) {
          return { folder, created: false };
        }
        throw err;
      }
      return { folder, created: true };
    });
  }

  /**
   * Delete `Plugins/<name>/` — the whole folder, its skills and tools
   * included, in ONE commit. MECHANISM only: the route owns the
   * authorization (the caller must hold the `owner` verb on the folder;
   * this service never re-derives it), exactly as `createPlugin` leaves
   * "any signed-in user" to its endpoint.
   *
   * Shape mirrors a provision run in reverse, with the same failure
   * contract: the folder is PARKED (renamed to a dot-prefixed sibling the
   * scanners ignore) rather than removed, the deletion is committed
   * synchronously, and only a landed commit lets the parked bytes go. A
   * refused commit renames the folder back, so a failed delete leaves the
   * plugin exactly as it was — never half-gone on disk while origin still
   * carries it.
   *
   * Serialised on the same slug-keyed lock creations use, so a delete can
   * never interleave with a re-creation of the same name (the key derives
   * from the name, so both spell it identically).
   */
  async deletePlugin(user: AuthUser, rawName: string): Promise<void> {
    const name = rawName.trim();
    if (!name) throw new PluginProvisionError('A plugin needs a name.', 422);
    if (isPersonalPluginFolder(name)) {
      // Personal folders are not plugins (the catalog never lists them), and
      // nobody deletes somebody's private shelf through the plugin door.
      throw new PluginProvisionError('Unknown plugin', 404);
    }
    return this.creations.run(`plugin:${pluginManifestName(name)}`, async () => {
      const existing = await this.existingFolder(name);
      // Exact match only — the catalog hands the route the on-disk casing,
      // so a mismatch means the plugin is gone (or was never there).
      if (existing !== name) throw new PluginProvisionError('Unknown plugin', 404);

      const wsId = await this.readyWorkspaceId();
      const wsDir = await this.workspaceService.getWorkspacePath(wsId);
      const pluginsDir = path.join(wsDir, this.kbDirName, PLUGINS_DIR);
      const folderDir = path.join(pluginsDir, name);
      // Dot-prefixed ⇒ invisible to the plugin scanner and the collision
      // check for the whole window the commit is in flight.
      const parkedDir = path.join(pluginsDir, `.${name}.deleting`);

      await fs.rm(parkedDir, { recursive: true, force: true }); // a stale park from a crashed run
      await fs.rename(folderDir, parkedDir);
      try {
        // Inline and `systemAuthorized`, for `provision`'s reasons in
        // reverse: the gate reads rules at HEAD, and the endpoint has
        // already authorized the delete (owner verdict), so the per-user
        // push gate — which would re-read an access.md this very commit
        // removes — is skipped for exactly this commit. `commitFile` is
        // path-scoped (`git add -- <path>`), and a folder path stages every
        // deletion under it: one commit, one removed plugin.
        await this.commits.runPendingCommit(
          wsId,
          DEFAULT_BRANCH,
          `${this.kbDirName}/${PLUGINS_DIR}/${name}`,
          user,
          { systemAuthorized: true },
        );
      } catch (err) {
        // The commit did not land: put the folder back, so a failed delete
        // is a no-op rather than a plugin that exists at origin but not here.
        try {
          await fs.rename(parkedDir, folderDir);
        } catch {
          /* the park survives for the next attempt — better than masking the real error */
        }
        throw err;
      }
      await fs.rm(parkedDir, { recursive: true, force: true }).catch(() => {});
      // The folder's rules left the access model — drop the resolver cache
      // so the very next check runs against a tree without them.
      this.accessControl.invalidate(wsId);
      this.events?.emit({ kind: 'fs-tree-changed', workspaceId: wsId, branch: DEFAULT_BRANCH });
    });
  }

  /** The taken name (in its on-disk casing) colliding with `name`, or null. */
  private async existingFolder(name: string): Promise<string | null> {
    const wsId = await this.readyWorkspaceId();
    const wsDir = await this.workspaceService.getWorkspacePath(wsId);
    let children: string[];
    try {
      children = await fs.readdir(path.join(wsDir, this.kbDirName, PLUGINS_DIR));
    } catch {
      return null; // no Plugins/ root yet — nothing can collide
    }
    const lower = name.toLowerCase();
    return children.find((c) => c.toLowerCase() === lower) ?? null;
  }

  /** An existing PLUGIN FOLDER whose derived manifest name equals `name`'s, or null. */
  private async manifestNameTwin(name: string): Promise<string | null> {
    const wsId = await this.readyWorkspaceId();
    const wsDir = await this.workspaceService.getWorkspacePath(wsId);
    let children: Array<{ name: string; isDirectory(): boolean }>;
    try {
      children = await fs.readdir(path.join(wsDir, this.kbDirName, PLUGINS_DIR), {
        withFileTypes: true,
      });
    } catch {
      return null; // no Plugins/ root yet — nothing can collide
    }
    const slug = pluginManifestName(name);
    // Only what actually publishes a manifest claims a slug: a DIRECTORY
    // that is not dot-prefixed (a parked delete — invisible to every
    // scanner). Personal folders count — they publish a plugin.json like
    // any plugin (though the reservation above means a named plugin can
    // never reach this check with a personal slug). A loose file at the
    // root (`Plugins/slack.tool`) is not a plugin and must not 409 a
    // legitimate "Slack Tool".
    return (
      children.find(
        (c) => c.isDirectory() && !c.name.startsWith('.') && pluginManifestName(c.name) === slug,
      )?.name ?? null
    );
  }

  private async provision(user: AuthUser, folder: string, accessMd: string): Promise<void> {
    const wsId = await this.readyWorkspaceId();
    const folderPath = `${this.kbDirName}/${PLUGINS_DIR}/${folder}`;
    const wsRelPath = `${folderPath}/access.md`;
    try {
      // Exclusive create — the fs is the arbiter of a same-name race, not
      // the (stale-able) existence check above. `access.md` stays the marker
      // that a folder is real (every scanner keys on it), so it is still the
      // file the race is decided on.
      await this.workspaceService.writeFile(wsId, wsRelPath, accessMd, { failIfExists: true });
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        throw new PluginProvisionError(`A plugin named "${folder}" already exists.`, 409);
      }
      throw err;
    }
    try {
      // The manifest is what makes the folder a PLUGIN to anything outside
      // this app, so it lands in the same commit as the access rules — and
      // INSIDE the rollback scope: a manifest write that fails must clean up
      // the access.md it would otherwise strand as a half-made plugin.
      await this.workspaceService.writeFile(
        wsId,
        `${folderPath}/${PLUGIN_MANIFEST_FILE}`,
        renderPluginManifest(folder),
      );
      // Inline, not enqueued: the gate reads rules at HEAD, so the folder is
      // only real once this commit lands. `runPendingCommit` is the same
      // commit+push (with pull-rebase recovery) the queue worker runs.
      // `systemAuthorized`: the push gate reads access at origin, where this
      // folder does not exist yet and the root says `write: Admin` — the very
      // rule this endpoint exists to carve through. The endpoint has already
      // authorized the write (any signed-in user, unused name, exclusive
      // create), so the per-user gate is skipped for exactly this commit.
      await this.commits.runPendingCommit(wsId, DEFAULT_BRANCH, folderPath, user, {
        systemAuthorized: true,
      });
    } catch (err) {
      // The commit did not land: roll the seeded file back off the disk,
      // best-effort, so a retry doesn't find a half-made plugin and report
      // "already exists" for something that never got committed. Only OUR
      // file and — when that leaves it empty — the folder; never recursive,
      // so a concurrent writer's bytes can't be collateral.
      try {
        const wsDir = await this.workspaceService.getWorkspacePath(wsId);
        const folderDir = path.join(wsDir, this.kbDirName, PLUGINS_DIR, folder);
        await fs.rm(path.join(folderDir, 'access.md'), { force: true });
        await fs.rm(path.join(folderDir, PLUGIN_MANIFEST_FILE), { force: true });
        await fs.rmdir(folderDir).catch(() => {});
      } catch {
        /* leave it for the next attempt's wx conflict — better than masking the real error */
      }
      throw err;
    }
    // The folder's rules changed the access model — drop the resolver cache
    // so the very next check (the creator's first skill write) sees them.
    this.accessControl.invalidate(wsId);
    this.events?.emit({ kind: 'fs-tree-changed', workspaceId: wsId, branch: DEFAULT_BRANCH });
  }

  private async readyWorkspaceId(): Promise<string> {
    const ws = await this.workspaceService.getOrCreateForBranch(DEFAULT_BRANCH);
    return ws.id;
  }
}

/**
 * A named plugin's access.md: discoverable file (frontmatter `read: everyone`
 * — anyone may see the plugin listed and ask to join), creator-run folder
 * (body read/write/owner name the creator). The `read: []` placeholder makes
 * the body parse as rules from the first byte, so every later splice targets
 * the body rather than the frontmatter.
 */
export function pluginAccessMd(creator: { name: string; email: string }): string {
  return withCreatorGrants('---\nread:\n  - everyone\n---\nread: []\n', creator);
}

/**
 * A personal folder's access.md: PRIVATE — no frontmatter grant, so the
 * folder is invisible to everyone but its owner; the body names the owner
 * under read, write and owner.
 */
export function personalAccessMd(creator: { name: string; email: string }): string {
  return withCreatorGrants('read: []\n', creator);
}

function withCreatorGrants(base: string, creator: { name: string; email: string }): string {
  const principal = creatorPrincipal(creator);
  let out = base;
  for (const verb of ['read', 'write', 'owner'] as const) {
    out = spliceGrant(out, verb, principal, { allowScalar: false, target: 'folder' }).text;
  }
  return out;
}
