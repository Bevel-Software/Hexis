import path from 'node:path';
import { DEFAULT_BRANCH, skillUnderRoot } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { ISkillService } from '../skills/skills.contract.js';
import { TtlCache } from '../../shared/ttl-cache.js';
import { PLUGIN_TOKEN_PREFIX } from '../access-model/access-grammar.js';
import type { PluginMembership } from './plugins.contract.js';
import type { PluginSource } from './discovery/plugin-source.js';
import { KbPluginSource } from './discovery/kb-plugin-source.js';

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
  /** Whether hexis writes these links and checks their grants — see `DiscoveredPlugin`. */
  linksAreManaged: boolean;
}

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
 * `granted` is the consistency check the amber dot renders: a linked skill
 * whose own access rules DO grant the plugin's `plugin/<Name>/read`
 * principal (directly or from a scope above it). The link service writes
 * that grant with the link; only a hand edit takes it away.
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
    now: () => number = Date.now,
    private readonly source: PluginSource = new KbPluginSource(),
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
    for (const w of discovered.warnings) console.warn(`[plugins] ${w}`);

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
      for (const root of roots) {
        const hits = skills.filter((s) => skillUnderRoot(s.path, root)).map((s) => s.path);
        if (hits.length === 0) unresolvedRoots.push(root);
        for (const hit of hits) if (!linkedSkills.includes(hit)) linkedSkills.push(hit);
      }
      byPlugin.set(plugin.name, {
        name: plugin.name,
        folder: plugin.folder,
        roots,
        linkedSkills,
        unresolvedRoots,
        linksAreManaged: plugin.linksAreManaged,
      });
      if (linkedSkills.length === 0) continue;
      const token = `${PLUGIN_TOKEN_PREFIX}${plugin.name}/read`;
      for (const skillPath of linkedSkills) {
        // A skill that also sits INSIDE this plugin folder is inline, and its
        // inline membership already stands.
        if (skillPath.startsWith(`${plugin.folder}/`)) continue;
        // An unmanaged (dialect) link is a plain reference: nothing to grant,
        // nothing to repair — the skill's own scope decides who reads it.
        const granted = plugin.linksAreManaged ? await this.isGranted(wsId, skillPath, token) : true;
        add(skillPath, { name: plugin.name, linked: true, granted });
      }
    }
    return { bySkill, byPlugin };
  }

  /** Whether the skill folder's effective readers include the plugin's read principal. */
  private async isGranted(wsId: string, skillPath: string, token: string): Promise<boolean> {
    try {
      const readers = await this.accessControl.eligibleReaders(wsId, skillPath);
      if (!readers.restricted) return true; // readable by everyone — the plugin's members included
      return (readers.principals ?? []).some((p) => p.kind === 'plugin' && p.name === token);
    } catch {
      return false; // fail closed: an unreadable tree reports the link as needing repair
    }
  }
}

/** The default-branch workspace id every link resolution runs against. */
export function linksWorkspaceId(): string {
  return workspaceIdForBranch(DEFAULT_BRANCH);
}
