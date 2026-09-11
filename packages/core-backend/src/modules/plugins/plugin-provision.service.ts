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
 *   - A PERSONAL folder (`personal-<user-id>`): private by design, in both
 *     blocks. The frontmatter denies `everyone` and names only the owner,
 *     so nobody else can even see it exists; the body says the same of the
 *     folder. Created lazily (ensure semantics) on the first personal skill.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAbsence } from '../../shared/fs-errors.js';
import type { Discovery, PluginSource } from './discovery/plugin-source.js';
import { KbPluginSource } from './discovery/kb-plugin-source.js';

import {
  DEFAULT_BRANCH,
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_SKILLS_DIR,
  pluginManifestName,
  renderPluginManifest,
  PERSONAL_PLUGIN_PREFIX,
  isPersonalPluginDir,
  isPersonalPluginFolder,
  personalPluginFolderName,
  validateFilename,
  type AuthUser,
} from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { creatorPrincipal } from '../access-model/creator.js';
import { spliceGrant } from '../access-model/access-splice.js';
import { WorkspaceMutex } from '../kb-fs/mutex.js';

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

/**
 * A directory's entries, or null when there is no such directory. ONLY
 * absence reads as "nothing there": a listing that fails for any other
 * reason (permissions, I/O) throws, because "the folder is not there" and
 * "the folder could not be read" must never collapse into one answer — the
 * first is a 404 to a caller, the second an outage an operator must see.
 */
async function listDirOrIncomplete(
  dir: string,
  repoRel: string,
): Promise<Array<{ name: string; isDirectory(): boolean }> | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isAbsence(err)) return null;
    // The same refusal a hole in discovery gets: this listing is one more
    // read the operation needed and could not have.
    throw incompleteDiscovery([repoRel]);
  }
}

/** The refusal for a discovery with a hole in it: a name cannot be checked, an identity cannot be known. */
function incompleteDiscovery(unreadable: string[]): PluginProvisionError {
  return new PluginProvisionError(
    `Some of the knowledge base could not be read (${unreadable.join(', ')}), so the plugin cannot be checked against every other. Try again, or ask an admin.`,
    503,
  );
}

export interface ProvisionedPlugin {
  /** The folder's path below `Plugins/` — `GTM`, or `Teams/GTM` for one made inside a grouping folder. */
  folder: string;
  /** The same folder, repo-relative — `Plugins/Teams/GTM` — as the file tools address it. */
  path: string;
  /** Where its skills go: `<path>/skills`, each skill a subfolder holding a `SKILL.md`. */
  skillsDir: string;
  /** The plugin's identity — the manifest name written for it. */
  name: string;
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

/** The one shape every provisioning answer has: the folder in both spellings, and where its skills go. */
function provisioned(folder: string, name: string, created: boolean): ProvisionedPlugin {
  const path = `${PLUGINS_DIR}/${folder}`;
  return { folder, path, skillsDir: `${path}/${PLUGIN_SKILLS_DIR}`, name, created };
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
    /** Which names are TAKEN is discovery's answer — the same one every catalog gets. */
    private readonly source: PluginSource = new KbPluginSource(),
  ) {}

  /**
   * Create `Plugins/<name>/` — or `Plugins/<parent>/<name>/` — for `user`.
   * Throws `PluginProvisionError` 422 on a name the filesystem or the model
   * cannot carry, 409 when the name is taken (case-insensitively — the
   * workspaces live on case-insensitive filesystems too, where `GTM` and
   * `gtm` are one folder), 404 when `parent` names no folder.
   *
   * `parent` is a GROUPING folder below the plugins root (`Teams`,
   * `Teams/EU`): it must exist, and it must not be a plugin or sit inside
   * one — discovery claims a plugin's whole subtree, so a plugin made there
   * would be invisible to every catalog. The identity checks are the same at
   * any depth: a nested plugin claims its slug as fully as a top-level one.
   */
  async createPlugin(user: AuthUser, rawName: string, rawParent?: string): Promise<ProvisionedPlugin> {
    const name = rawName.trim();
    if (!name) throw new PluginProvisionError('A plugin needs a name.', 422);
    // NUL and control chars are exactly what a filesystem path cannot carry;
    // refusing them here keeps the refusal a 422 instead of the fs layer's 500.
    // eslint-disable-next-line no-control-regex
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
    // The name is judged before the parent: a name that can never be created
    // is refused as such, not as "no such folder" or "discovery incomplete".
    const parent = await this.resolveParent(rawParent);
    // Locked on the manifest SLUG, not the lowercased folder: the slug is the
    // identity the twin check below defends, and two spellings that collide
    // on it ("Sales Team" / "Sales-Team") must take the SAME lock or both
    // pass the check concurrently. Case-variants share a slug too, so this
    // key subsumes the old lowercase one — and deletion (below) derives its
    // key the same way, keeping delete/re-create of one name serialized.
    return this.creations.run(`plugin:${pluginManifestName(name)}`, async () => {
      const existing = await this.existingFolder(name, parent);
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
      const folder = parent ? `${parent}/${name}` : name;
      await this.provision(user, folder, name, pluginAccessMd(user));
      return provisioned(folder, pluginManifestName(name), true);
    });
  }

  /**
   * The grouping folder a creation goes into, as its path below the plugins
   * root — `''` for the root itself. Validated AS GIVEN, segment by segment,
   * with the one rule every path here obeys (`validateFilename`, no
   * dot-prefix); it must exist with every component spelled as on disk; and
   * it must be a GROUPING folder — not a personal space, not a plugin, not
   * inside one, since discovery claims a plugin's subtree and a plugin made
   * there would be listed nowhere. A hole in discovery refuses, as for every
   * other provisioning write.
   */
  private async resolveParent(rawParent: string | undefined): Promise<string> {
    if (rawParent === undefined || rawParent === '') return '';
    const segments = rawParent.split('/');
    if (segments.some((s) => validateFilename(s) !== null || s.startsWith('.'))) {
      throw new PluginProvisionError(`"${rawParent}" is not a folder name the knowledge base can carry.`, 422);
    }
    const rel = `${PLUGINS_DIR}/${rawParent}`;
    // The personal namespace is the FIRST segment below the root — the same
    // structural rule as `isPersonalPluginDir`, applied to the parent and
    // everything under it. A `personal-*` folder there is a personal space
    // whether it was provisioned yet or not: the prefix is reserved at that
    // depth (creation refuses the slug, rename refuses the name).
    if (isPersonalPluginFolder(segments[0]!)) {
      throw new PluginProvisionError('A plugin cannot be made inside a personal space.', 422);
    }
    const wsId = await this.readyWorkspaceId();
    const wsDir = await this.workspaceService.getWorkspacePath(wsId);
    if (!(await this.exactFolderExists(path.join(wsDir, this.kbDirName, PLUGINS_DIR), segments))) {
      throw new PluginProvisionError(`There is no folder "${rawParent}" under ${PLUGINS_DIR}/.`, 404);
    }
    // Judged against every folder discovery CLAIMS, not only the plugins it
    // lists: a twin skipped for its slug still owns its subtree, and a
    // plugin made in there would be listed by no catalog.
    const { claimed, unreadable } = await this.discovered();
    if (unreadable.length > 0) throw incompleteDiscovery(unreadable);
    const inside = claimed.find((c) => rel === c || rel.startsWith(`${c}/`));
    if (inside) {
      throw new PluginProvisionError(
        `"${rawParent}" is inside the plugin at ${inside} — a plugin cannot hold another plugin.`,
        422,
      );
    }
    return rawParent;
  }

  /**
   * Ensure the caller's personal folder exists — idempotent, keyed to the
   * stable user id. Returns `created: false` when it is already there.
   */
  async ensurePersonalPlugin(user: AuthUser): Promise<ProvisionedPlugin> {
    const folder = personalPluginFolderName(user.id);
    return this.creations.run(`plugin:${pluginManifestName(folder)}`, async () => {
      if ((await this.existingFolder(folder)) !== null) {
        return provisioned(folder, pluginManifestName(folder), false);
      }
      try {
        await this.provision(user, folder, folder, personalAccessMd(user));
      } catch (err) {
        // ENSURE semantics even under a race the lock cannot see (another
        // process, a checkout that appeared between check and write): the
        // folder existing is this method's success case, never its error.
        if (err instanceof PluginProvisionError && err.status === 409) {
          return provisioned(folder, pluginManifestName(folder), false);
        }
        throw err;
      }
      return provisioned(folder, pluginManifestName(folder), true);
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
  async deletePlugin(user: AuthUser, rawFolder: string): Promise<void> {
    // The folder's path BELOW the plugins root — `GTM`, or `teams/deep` for a
    // plugin nested where discovery found it. Segments only: nothing that
    // could climb out of the root, and no backslash — `/` is the one
    // separator the repository speaks, and a `\` would read as a second one
    // on Windows and as a name character everywhere else.
    // Validated AS GIVEN, never trimmed first: a folder spelled with a
    // leading or trailing space names no folder the catalog handed out, and
    // trimming it would delete a different one. (`validateFilename` refuses
    // the whitespace.)
    const name = rawFolder;
    const segments = name.split('/');
    // Every segment must be a name the filesystem carries (the ONE rule
    // creation applies, `validateFilename`: no control characters, no `\`,
    // no `.`/`..`, no reserved names) and none may be dot-prefixed (a parked
    // delete, invisible to every scanner) — refused here as a 422, never
    // discovered by the fs layer as a 500.
    if (!name || segments.some((s) => validateFilename(s) !== null || s.startsWith('.'))) {
      throw new PluginProvisionError('A plugin needs a name.', 422);
    }
    if (isPersonalPluginDir(`${PLUGINS_DIR}/${name}`)) {
      // Personal folders are not plugins (the catalog never lists them), and
      // nobody deletes somebody's private shelf through the plugin door.
      throw new PluginProvisionError('Unknown plugin', 404);
    }
    const wsId = await this.readyWorkspaceId();
    const wsDir = await this.workspaceService.getWorkspacePath(wsId);
    const pluginsDir = path.join(wsDir, this.kbDirName, PLUGINS_DIR);
    const folderDir = path.join(pluginsDir, ...segments);
    // Locked on the plugin's IDENTITY — the same key a creation of that name
    // takes — not on a slug of the folder path, which for a nested plugin is a
    // different string and would let a creation of the same identity run
    // inside the delete's window. The identity is DISCOVERY's answer, in
    // either file shape (a bundle's name as much as a manifest's), so delete
    // and create can never key on two spellings of one plugin; a hole in
    // discovery refuses, as it does for creation. A folder discovery does not
    // list (no manifest at all) locks on its own slug — nothing else can
    // claim that identity either.
    const identity = await this.discoveredIdentity(`${PLUGINS_DIR}/${name}`, segments[segments.length - 1]!);
    return this.creations.run(`plugin:${identity}`, async () => {
      // Exact spelling of EVERY component — the catalog hands the route the
      // on-disk spelling, so a mismatch means the plugin is gone (or was
      // never there). Checked against directory listings, never `stat`: on a
      // case-insensitive filesystem a stale spelling would stat a replacement
      // plugin at the same location and park THAT.
      if (!(await this.exactFolderExists(pluginsDir, segments))) {
        throw new PluginProvisionError('Unknown plugin', 404);
      }

      // Dot-prefixed ⇒ invisible to the plugin scanner and the collision
      // check for the whole window the commit is in flight. UNIQUE, so the
      // park never lands on — and never removes — a path that was already
      // there: a sibling somebody named that way, or the residue of a run
      // that crashed mid-delete (which stays, invisible, for a person to
      // clear; a delete must never destroy anything but the plugin it names).
      // FIXED LENGTH: the plugin's own name is not part of it, so a name near
      // the filesystem's component limit parks as well as a short one.
      const parkedDir = path.join(path.dirname(folderDir), `.deleting-${randomUUID()}`);
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

  /**
   * Whether `segments` names a directory below `root` with every component
   * spelled exactly as on disk — by listing each level, which is the one
   * question a case-insensitive filesystem answers honestly.
   */
  private async exactFolderExists(root: string, segments: string[]): Promise<boolean> {
    let dir = root;
    let rel = PLUGINS_DIR;
    for (const segment of segments) {
      const entries = await listDirOrIncomplete(dir, rel);
      if (!entries?.some((e) => e.isDirectory() && e.name === segment)) return false;
      dir = path.join(dir, segment);
      rel = `${rel}/${segment}`;
    }
    return true;
  }

  /**
   * The taken name (in its on-disk casing) colliding with `name` in `parent`
   * (`''` = the plugins root), or null.
   */
  private async existingFolder(name: string, parent = ''): Promise<string | null> {
    const wsId = await this.readyWorkspaceId();
    const wsDir = await this.workspaceService.getWorkspacePath(wsId);
    const rel = parent ? `${PLUGINS_DIR}/${parent}` : PLUGINS_DIR;
    // No Plugins/ root yet — nothing can collide.
    const children = await listDirOrIncomplete(path.join(wsDir, this.kbDirName, rel), rel);
    if (!children) return null;
    const lower = name.toLowerCase();
    return children.find((c) => c.name.toLowerCase() === lower)?.name ?? null;
  }

  /**
   * The identity discovery gives the plugin at `folder`, or the folder's own
   * slug when it lists none there. ONE rule for every write provisioning
   * makes — create, delete — as for the rename: no write over a discovery
   * with a hole in it, whether or not the hole is where this plugin lives.
   * An operation that parks and commits against an identity set it could
   * not fully see is the class of mistake the rule exists to make impossible.
   */
  private async discoveredIdentity(folder: string, leaf: string): Promise<string> {
    const { plugins, unreadable } = await this.discovered();
    if (unreadable.length > 0) throw incompleteDiscovery(unreadable);
    const found = plugins.find((p) => p.folder === folder);
    // The lock key is the SLUG — what the marketplace publishes and what a
    // creation of the name locks on — so a bundle declaring "Sales Team"
    // and a creation of `sales-team` take one lock. Not listed and nothing
    // unreadable: no manifest, no bundle — the folder is its own identity.
    return pluginManifestName(found ? found.name : leaf);
  }

  /** One discovery over the knowledge base checkout. */
  private async discovered(): Promise<Discovery> {
    const wsId = await this.readyWorkspaceId();
    const wsDir = await this.workspaceService.getWorkspacePath(wsId);
    return this.source.discover(path.join(wsDir, this.kbDirName));
  }

  /**
   * An existing plugin — at ANY depth, in either file shape — whose identity
   * folds to the same slug as `name`'s, as its repo-relative folder; or null.
   * Discovery's answer, so creation and every catalog agree on what is taken:
   * a nested plugin claims its identity as fully as a top-level one, and a
   * parked delete (dot-prefixed, invisible to the walk) claims nothing.
   * Personal folders count — they publish a plugin.json like any plugin
   * (though the reservation above means a named plugin never reaches this
   * check with a personal slug). A loose file at the root is not a plugin.
   *
   * Refuses on a HOLE: a listing that could not see part of the tree cannot
   * prove a name free.
   */
  private async manifestNameTwin(name: string): Promise<string | null> {
    const { plugins, unreadable } = await this.discovered();
    if (unreadable.length > 0) throw incompleteDiscovery(unreadable);
    const slug = pluginManifestName(name);
    return plugins.find((p) => pluginManifestName(p.name) === slug)?.folder ?? null;
  }

  /**
   * Seed `Plugins/<folder>/` — `folder` being the path below the root, `leaf`
   * its last segment, which names the manifest — and commit it.
   */
  private async provision(user: AuthUser, folder: string, leaf: string, accessMd: string): Promise<void> {
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
        renderPluginManifest(leaf),
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
 *
 * The comments are part of the template on purpose. The file is what an
 * administrator opens to widen a plugin, and the two blocks look alike: a
 * person who finds `everyone` already under the top `read:` and adds nothing
 * concludes that "everyone" does nothing. Each block says what it governs,
 * and the body says how to admit people, right where they would type it.
 * `spliceGrant` preserves comments, so every later edit keeps them.
 */
export function pluginAccessMd(creator: { name: string; email: string }): string {
  return withCreatorGrants(
    [
      '---',
      '# THIS BLOCK (the frontmatter) governs this access.md FILE only: who may',
      '# see it and who may change it. `read: everyone` here means every signed-in',
      '# person can see that the plugin exists and ask to join. It admits nobody.',
      'read:',
      '  - everyone',
      '---',
      '# THIS BLOCK (the body) governs the PLUGIN FOLDER — its skills, tools and',
      '# manifest. To admit people, add them under `read:` (use it) or `write:`',
      '# (change it): a role from roles.yaml, a group from groups.yaml, or a person',
      '# as `Name <email>`. `everyone` under `read:` HERE opens the plugin to all',
      '# signed-in users. Keep this block pure YAML; explanations go in `#` lines.',
      'read: []',
      '',
    ].join('\n'),
    creator,
  );
}

/**
 * A personal folder's access.md: PRIVATE, in both blocks. The body DENIES
 * `everyone` read outright, so a `read: everyone` an administrator later
 * adds at the repo root (the usual way to open the knowledge base up) cannot
 * open every person's private space with it, and names the owner directly,
 * which outranks the denial. The frontmatter says the same of the FILE — so
 * the folder's listing is invisible to everyone but the owner, and so the
 * file states its own privacy where a reader (and the Library's "Private"
 * mark, see `isPrivateAccessMd`) looks for it, rather than leaving it to
 * what an empty block happens to inherit. Nobody else is named — not even
 * Admin: a private space is private from the people who run the deployment
 * too. (An administrator can still write this file, through the resolver's
 * access.md rescue, and so grant themselves in; that is a visible act in
 * the history, not a default.)
 *
 * The frontmatter is also what marks the file as body-governed. Without it
 * the splicer (and the resolver) read the older single-block format, where
 * the frontmatter IS the folder's rules.
 */
export function personalAccessMd(creator: { name: string; email: string }): string {
  const seeded = withCreatorGrants(
    [
      '---',
      '# THIS BLOCK (the frontmatter) governs this access.md FILE only. Only the',
      '# owner is named: a personal space is not listed for anyone else.',
      'read:',
      '  - deny everyone',
      '---',
      '# THIS BLOCK (the body) governs the FOLDER — one person\'s private space.',
      '# `deny everyone` keeps it closed even when the repository root grants',
      '# `read: everyone`; only the owner is named — not even Admin reads it.',
      '# To share it, add a person as `Name <email>` or a role under `read:`.',
      'read:',
      '  - deny everyone',
      '',
    ].join('\n'),
    creator,
  );
  return spliceGrant(seeded, 'read', creatorPrincipal(creator), { allowScalar: false, target: 'node' }).text;
}

function withCreatorGrants(base: string, creator: { name: string; email: string }): string {
  const principal = creatorPrincipal(creator);
  let out = base;
  for (const verb of ['read', 'write', 'owner'] as const) {
    out = spliceGrant(out, verb, principal, { allowScalar: false, target: 'folder' }).text;
  }
  return out;
}
