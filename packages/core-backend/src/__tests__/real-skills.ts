import type { ITreeWalker } from '../shared/fs.contract.js';
import type { KbContext } from '../shared/kb-context.js';
import type { WorkspaceService } from '../modules/workspace/index.js';
import type { IAccessControl } from '../modules/access/index.js';
import { SkillService } from '../modules/skills/skills.service.js';

/**
 * The skill catalog over a real tree, wired the way the composition root
 * wires it (`core/create-core-services.ts`). A module's suite that needs the
 * real catalog (what skills exist, which the caller may read) takes it from
 * HERE rather than constructing another module's implementation itself: the
 * service is a type on the skills entry, by design, and this fixture stands
 * in for the root, as `real-access.ts` does for the access resolver.
 */
export function realSkillService(
  workspace: WorkspaceService,
  access: IAccessControl,
  kb: KbContext,
  disk: ITreeWalker,
): SkillService {
  return new SkillService(workspace, access, kb, disk);
}
