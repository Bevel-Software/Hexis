import type { ITreeWalker } from '../shared/fs.contract.js';
import type { KbContext } from '../shared/kb-context.js';
import type { WorkspaceService } from '../modules/workspace/index.js';
import type { IAccessControl } from '../modules/access/index.js';
import { SkillService } from '../modules/skills/skills.service.js';

/**
 * The skill catalog over a real tree, wired the way the composition root
 * wires it (`core/create-core-services.ts`). A module's suite that resolves
 * real skill folders (a plugin's links, its leftover grants) takes it from
 * HERE rather than constructing the skills module's implementation itself:
 * `SkillService` is a type-only export of that module's entry, by design,
 * and this fixture stands in for the root, as `real-access.ts` does for the
 * resolver.
 */
export function realSkills(
  workspace: WorkspaceService,
  access: IAccessControl,
  kb: KbContext,
  disk: ITreeWalker,
): SkillService {
  return new SkillService(workspace, access, kb, disk);
}
