import path from 'node:path';
import { logger } from '../../shared/logging.js';

const log = logger('plugins');
import { DEFAULT_BRANCH, pluginManifestName, skillUnderRoot } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { ISkillService } from '../skills/skills.contract.js';
import { TtlCache } from '../../shared/ttl-cache.js';
import { canonicalRoleName, pluginPrincipalKey } from '../access-model/access-grammar.js';
import type { PluginMembership } from './plugins.contract.js';
import type { PluginSource } from './discovery/plugin-source.js';

const CACHE_TTL_MS = 60_000;

/** One plugin's links, resolved against the released catalog. */
export interface PluginLinks {
  /** The plugin's name — its identity to people and URLs. */
  name: string;
  /** Repo-relative plugin folder. */
  folder: string;
  /** The roots the manifest declares, normalised. */
  roots: string[];
  /** Skill folders the roots resolve to (released catalog only). */
  linkedSkills: string[];
  /** Roots that resolve to no released skill — a typo, or a skill not yet merged. */
  unresolvedRoots: string[];
  /**
   * The declared roots whose OWN access file does not carry this plugin's two
   * grant lines, each with the linked skills its members cannot read through
   * it — the automatic repair's work list, and the only thing that says WHICH
   * file to write (`brokenLinks` counts skills, and a root holding twenty of
   * them is still one file). Empty for an unmanaged (dialect) plugin, whose
   * links grant nothing, and for a plugin whose links are all healthy.
   */
  ungrantedRoots: UngrantedRoot[];
  /** Whether hexis writes these links and checks their grants — see `DiscoveredPlugin`. */
  linksAreManaged: boolean;
}

/** One declared root missing its grants, with the skills that go without. */
export interface UngrantedRoot {
  /** Repo-relative root, exactly as the manifest declares it. */
  root: string;
  /** The released skill folders under it the plugin's members cannot read. */
  skills: string[];
}

/**
 * The two verbs a link grants — the pair `PluginLinksService.grantTokens`
 * writes and this index looks for. `owner` is deliberately not one of them: a
 * link shares a skill and lets the plugin's managers edit it; it never hands
 * over who validates it.
 */
export const LINK_GRANT_VERBS = ['read', 'write'] as const;

export interface LinkMembership {
  /** skill path → every plugin that holds it, inline or by link. */
  bySkill: Map<string, PluginMembership[]>;
  /** plugin folder → its links. Every plugin folder appears, linked or not. */
  byPlugin: Map<string, PluginLinks>;
}

/**
 * The link index: which shared skills each plugin links, and — the other way
 * round — which plugins each skill belongs to, whether by sitting inside the
 * plugin folder or by being linked from its manifest.
 *
 * Plugins come from the configured {@link PluginSource} (native manifests, or
 * a customer dialect); resolution runs against the RELEASED catalog
 * (`skillService.listSkills()`, unfiltered), never the file system: the
 * catalog already applies the leaf-folder rule, the `.bevelignore` layers
 * and the global-name dedup, and a second walk here would be a second
 * opinion about what a skill is.
 *
 * `granted` is the consistency check the amber dot renders, and it is a
 * question about the FILE, not about who happens to be able to read the skill
 * today: a link is granted when the declared ROOT's own access file carries
 * both `plugin/<Name>/read` and `plugin/<Name>/write`, and neither is denied
 * at that root or between it and the skill. A root that is readable by
 * everyone, or that inherits a plugin grant from a folder above, is NOT
 * granted — the grant is the link's contract, and a public root merely hides
 * its absence until the day someone restricts the tree. The link service
 * writes those two lines with the link; only a hand edit takes them away.
 *
 * Cached briefly, dropped by `invalidate()` from the same file-change
 * subscriber that drops the plugin index, so a link committed on the default
 * branch shows within one round-trip.
 */
export class PluginLinkIndex {
  private readonly cache: TtlCache<LinkMembership>;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly skillService: ISkillService,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
    /** Where plugins come from — the one discovery every catalog shares. */
    private readonly source: PluginSource,
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(CACHE_TTL_MS, now);
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  async membership(): Promise<LinkMembership> {
    const cached = this.cache.get();
    if (cached) return cached;
    // Token first, like the other catalogs: an `invalidate()` landing while
    // the build reads the pre-change tree must not be undone by storing that
    // read afterwards.
    const token = this.cache.begin();
    const built = await this.build();
    // A degraded read (no workspace yet) is served but not stored — the same
    // reasoning as the plugin index: caching a failure hides every link for
    // a full TTL after its cause is gone.
    if (built === null) return { bySkill: new Map(), byPlugin: new Map() };
    this.cache.set(built, token);
    return built;
  }

  /** Convenience: the memberships of one skill (empty when it is in no plugin). */
  async pluginsOf(skillPath: string): Promise<PluginMembership[]> {
    return (await this.membership()).bySkill.get(skillPath) ?? [];
  }

  // --- internal --------------------------------------------------------------

  private async build(): Promise<LinkMembership | null> {
    let wsId: string;
    let kbRoot: string;
    try {
      wsId = (await this.workspaceService.getOrCreateForBranch(DEFAULT_BRANCH)).id;
      kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);
    } catch {
      return null;
    }
    const skills = await this.skillService.listSkills(undefined);
    const bySkill = new Map<string, PluginMembership[]>();
    const byPlugin = new Map<string, PluginLinks>();
    const add = (skillPath: string, m: PluginMembership) => {
      const list = bySkill.get(skillPath) ?? [];
      if (!list.some((x) => x.name === m.name)) list.push(m);
      bySkill.set(skillPath, list);
    };

    const discovered = await this.source.discover(kbRoot);
    for (const w of discovered.warnings) log.warn(w);

    // Inline skills: the ones sitting INSIDE a plugin's folder, matched by
    // folder prefix (a plugin may sit at any depth, so the second path
    // segment says nothing). Personal folders are places, not plugins —
    // their skills belong to nobody's plugin.
    const ownerOf = (skillPath: string) =>
      discovered.plugins.find((p) => !p.personal && p.exists && skillPath.startsWith(`${p.folder}/`));
    for (const s of skills) {
      const owner = ownerOf(s.path);
      if (owner) add(s.path, { name: owner.name, linked: false, granted: true });
    }

    for (const plugin of discovered.plugins) {
      // Personal folders are places, not plugins; a manifest without the
      // access.md that makes a plugin EXIST is a ghost the index and the
      // compiler omit, so it must not be linkable or hold grants either.
      if (plugin.personal || !plugin.exists) continue;
      const roots = plugin.linkedRoots;
      const linkedSkills: string[] = [];
      const unresolvedRoots: string[] = [];
      /** Which declared roots each linked skill arrives through. */
      const rootsOfSkill = new Map<string, string[]>();
      for (const root of roots) {
        const hits = skills.filter((s) => skillUnderRoot(s.path, root)).map((s) => s.path);
        if (hits.length === 0) unresolvedRoots.push(root);
        for (const hit of hits) {
          if (!linkedSkills.includes(hit)) linkedSkills.push(hit);
          rootsOfSkill.set(hit, [...(rootsOfSkill.get(hit) ?? []), root]);
        }
      }
      // A skill — or a root — that sits INSIDE this plugin's folder is inline:
      // its membership already stands, and no grant is written for it.
      const inline = (p: string) => p === plugin.folder || p.startsWith(`${plugin.folder}/`);
      const slug = pluginManifestName(plugin.name);
      // Root by root FIRST, skill by skill second: the grant lives on the
      // root's access file, so a root holding twenty skills is one question to
      // the resolver, not twenty. An unmanaged (dialect) link is a plain
      // reference — nothing to grant, nothing to repair — so it asks none.
      const carriesGrants = new Map<string, boolean>();
      if (plugin.linksAreManaged) {
        for (const root of roots) {
          if (inline(root)) continue;
          carriesGrants.set(root, await this.rootCarriesGrants(wsId, root, slug));
        }
      }
      const grantedSkills = new Map<string, boolean>();
      for (const skillPath of linkedSkills) {
        if (inline(skillPath)) continue;
        if (!plugin.linksAreManaged) {
          grantedSkills.set(skillPath, true);
          continue;
        }
        let granted = false;
        for (const root of rootsOfSkill.get(skillPath) ?? []) {
          if (!carriesGrants.get(root)) continue;
          if (await this.deniedBetween(wsId, root, skillPath, slug)) continue;
          granted = true;
          break;
        }
        grantedSkills.set(skillPath, granted);
      }
      // What the automatic repair has to write: a root missing its lines, with
      // the skills that are actually going without because of it. A root whose
      // skills all reach the plugin through ANOTHER declared root is nothing to
      // repair — there is no broken link to fix, and a write would be noise.
      const ungrantedRoots: UngrantedRoot[] = [];
      for (const root of roots) {
        if (inline(root) || carriesGrants.get(root) !== false) continue;
        const without = linkedSkills.filter(
          (s) => !inline(s) && (rootsOfSkill.get(s) ?? []).includes(root) && grantedSkills.get(s) === false,
        );
        if (without.length > 0) ungrantedRoots.push({ root, skills: without });
      }
      byPlugin.set(plugin.name, {
        name: plugin.name,
        folder: plugin.folder,
        roots,
        linkedSkills,
        unresolvedRoots,
        ungrantedRoots,
        linksAreManaged: plugin.linksAreManaged,
      });
      for (const skillPath of linkedSkills) {
        if (inline(skillPath)) continue;
        add(skillPath, { name: plugin.name, linked: true, granted: grantedSkills.get(skillPath) === true });
      }
    }
    return { bySkill, byPlugin };
  }

  /**
   * Whether the ROOT's own access file carries both of the link's grant lines.
   *
   * "Its own" is the whole rule: `grantSources` reports every scope that
   * grants the principal, closest-first, so `[0].kind === 'direct'` is
   * "granted by the file this root's link writes" — a grant inherited from a
   * folder above is an `ancestor` source and does not count, and a root that
   * is simply public names the principal nowhere and yields no source at all.
   * `tokenMatch: 'exact'` pins the comparison to the canonical token the
   * grant is written as, the same spelling `grantTokens` splices.
   *
   * A `deny` of either token in that same file is not granted either, whatever
   * the resolver makes of a grant beside it: the deny is the operator's, the
   * repair never removes it, and reporting the link as healthy would hide the
   * one thing the banner exists to say. `locallyDeniedPrincipals` is what sees
   * it — the per-verb denial walk cannot, since a grant in the same scope wins
   * there and ends the walk.
   */
  private async rootCarriesGrants(wsId: string, root: string, slug: string): Promise<boolean> {
    try {
      for (const verb of LINK_GRANT_VERBS) {
        const principal = { kind: 'role' as const, role: pluginPrincipalKey(slug, verb) };
        const sources = await this.accessControl.grantSources(wsId, 'folder', root, principal, {
          tokenMatch: 'exact',
        });
        if (sources[verb]?.[0]?.kind !== 'direct') return false;
      }
      const denied = await this.accessControl.locallyDeniedPrincipals?.(wsId, 'folder', root);
      const tokens: string[] = LINK_GRANT_VERBS.map((verb) => pluginPrincipalKey(slug, verb));
      // The resolver reports display names; compare through the one canonicaliser.
      return !(denied?.principals ?? []).some((p) => tokens.includes(canonicalRoleName(p.name)));
    } catch {
      return false; // fail closed: an unreadable tree reports the link as needing repair
    }
  }

  /**
   * Whether either grant is DENIED below the root — at the skill's own folder
   * or at anything between it and the root.
   *
   * The denial walk stops at a closer grant, and the root's grant is what
   * brought us here, so what this reports is exactly the scopes under the
   * root: a `deny` above the root is dead under closeness-first and is not
   * this link's problem.
   */
  private async deniedBetween(wsId: string, root: string, skillPath: string, slug: string): Promise<boolean> {
    if (skillPath === root) return false; // the root's own file is `rootCarriesGrants`' business
    try {
      for (const verb of LINK_GRANT_VERBS) {
        const principal = { kind: 'role' as const, role: pluginPrincipalKey(slug, verb) };
        const denials = await this.accessControl.denialSources?.(wsId, 'folder', skillPath, principal, {
          tokenMatch: 'exact',
        });
        if ((denials?.[verb] ?? []).length > 0) return true;
      }
      return false;
    } catch {
      return true; // fail closed, as above
    }
  }
}

/** The default-branch workspace id every link resolution runs against. */
export function linksWorkspaceId(): string {
  return workspaceIdForBranch(DEFAULT_BRANCH);
}
