import express from 'express';
import { isPersonalPluginDir, isPersonalPluginFolder, pluginOfPath } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { ISkillService } from '../skills/skills.contract.js';
import type { IToolManualService } from '../tool-manuals/tool-manuals.contract.js';
import type { IPluginIndexService, PluginCatalogEntry } from './plugins.contract.js';
import { pluginsWorkspaceId } from './plugins.service.js';

/**
 * What one team can use, by id — the Library's "Your teams" lens.
 *
 * A team is a group from the active group source (`groups.yaml`, or the
 * IdP-synced file), and what it can use is what being IN it lets a person
 * read: the plugins whose rules admit the group, the skills those plugins
 * link or hold, a shared skill whose own folder names the group, the tools
 * declared in an admitted plugin. The verdict is the resolver's own
 * (`canReadAsGroupBatch`), so a grant reached through a role that lists the
 * group, or through `plugin/<name>/read` on a skill the group's plugin links,
 * counts exactly as it does for a member.
 *
 * Every id is ALSO gated on the caller: a skill or tool the caller cannot
 * read is not named here, however the team stands, and a plugin appears only
 * when the caller could see it on the index (a member, or able to discover
 * it). The lens never widens what the catalog already shows the caller — it
 * slices it.
 *
 * The list opens with `Everyone`: not a group, the built-in org-wide
 * principal — what a signed-in person in no group at all can use, which is
 * what `read: everyone` (or a public plugin) reaches. Same slice, same
 * caller gate, asked of the resolver as `canReadAsEveryoneBatch`. The name
 * cannot collide with a group's: `everyone` is reserved by the grammar.
 */
export interface TeamAccess {
  name: string;
  /** Plugin identities (manifest names) the team's members can read. */
  plugins: string[];
  /** Skill names. */
  skills: string[];
  /** Tool slugs. */
  tools: string[];
}

/** The org-wide entry's name — the built-in `everyone` principal, as the sidebar spells it. */
export const EVERYONE_TEAM = 'Everyone';

export function createTeamsRoutes(
  accessControl: IAccessControl,
  pluginIndex: IPluginIndexService,
  skillService: Pick<ISkillService, 'listSkills'>,
  toolManuals: Pick<IToolManualService, 'listAllSummaries'>,
): express.Router {
  const router = express.Router();

  router.get('/teams', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const wsId = pluginsWorkspaceId();
      const [{ groups }, catalog, allSkills, allTools] = await Promise.all([
        accessControl.kbPrincipals(wsId),
        pluginIndex.catalog(),
        skillService.listSkills(),
        toolManuals.listAllSummaries(),
      ]);
      // A personal plugin is one person's space, not a team's: it has no
      // roster and admits nobody, so neither it nor anything inside it can
      // be a team's to read — whatever a hand-written grant in there says.
      // One rule for the plugin and for its contents, so the two cannot
      // disagree.
      const plugins = catalog.filter((g) => !g.folders.every(isPersonalPluginDir));
      const skills = allSkills.filter((s) => !inPersonalPlugin(s.path));
      const tools = allTools.filter((t) => !inPersonalPlugin(t.path));
      const folderProbes = plugins.flatMap((g) => g.folders);
      const discoverProbes = folderProbes.map(accessMdOf);
      const skillProbes = skills.map((s) => skillMdOf(s.path));
      const toolProbes = tools.map((t) => t.path);
      const probes = [...new Set([...folderProbes, ...discoverProbes, ...skillProbes, ...toolProbes])];

      const caller = await accessControl.canReadBatch(wsId, email, probes);
      const callerReads = (p: string) => caller.get(p) === true;
      const callerSeesPlugin = (g: PluginCatalogEntry) =>
        g.folders.some((f) => callerReads(f) || callerReads(accessMdOf(f)));

      /** One entry: what `verdicts` reads, cut to what the caller sees. */
      const slice = (name: string, verdicts: Map<string, boolean>): TeamAccess => {
        const reads = (p: string) => verdicts.get(p) === true;
        return {
          name,
          plugins: plugins
            .filter((g) => g.folders.some(reads) && callerSeesPlugin(g))
            .map((g) => g.name),
          skills: skills
            .filter((s) => reads(skillMdOf(s.path)) && callerReads(skillMdOf(s.path)))
            .map((s) => s.name),
          tools: tools.filter((t) => reads(t.path) && callerReads(t.path)).map((t) => t.slug),
        };
      };

      const teams: TeamAccess[] = [
        slice(EVERYONE_TEAM, await accessControl.canReadAsEveryoneBatch(wsId, probes)),
      ];
      for (const name of groups) {
        const team = await accessControl.canReadAsGroupBatch(wsId, name, probes);
        if (team === null) continue; // gone between the two reads — nothing to say
        teams.push(slice(name, team));
      }
      res.json({ teams });
    } catch (err) {
      console.error('[teams] failed to list teams:', err);
      res.status(500).json({ error: 'Failed to list teams' });
    }
  });

  return router;
}

const accessMdOf = (folder: string) => `${folder}/access.md`;
const skillMdOf = (skillPath: string) => `${skillPath}/SKILL.md`;
/** Under `Plugins/personal-<id>/…` — one person's space, whatever it grants. */
const inPersonalPlugin = (repoPath: string) => {
  const folder = pluginOfPath(repoPath);
  return folder !== null && isPersonalPluginFolder(folder);
};
