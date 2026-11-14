import { ToolManualService, type McpAuthDiscoveryPort } from '../modules/tool-manuals/tool-manuals.service.js';
import type { IAccessControl } from '../modules/access/index.js';
import type { WorkspaceService } from '../modules/workspace/index.js';
import type { KbContext } from '../shared/kb-context.js';
import { realDisk, realPluginSource } from './real-disk.js';

export type { McpAuthDiscoveryPort };

/**
 * The tool-manual service over real files, wired the way the composition root
 * wires it (`core/create-core-services.ts`): the real disk, the plugin source
 * reading that same disk, and the discovery port set afterwards. A suite that
 * drives the service over real tool files takes it from HERE and never
 * constructs the class from its file — the class is on no module entry (a
 * service arrives by injection), and this fixture stands in for the root, as
 * `kb-context.ts` and `real-disk.ts` do for what they wire.
 */
export function realToolManualService(
  deps: {
    workspaceService: WorkspaceService;
    accessControl: IAccessControl;
    kb: KbContext;
    /** The disk the suite writes its files to; the service reads the same one. */
    disk?: ReturnType<typeof realDisk>;
  },
  discovery?: McpAuthDiscoveryPort,
): ToolManualService {
  const disk = deps.disk ?? realDisk();
  const svc = new ToolManualService(deps.workspaceService, deps.accessControl, deps.kb, disk, realPluginSource(disk, deps.kb));
  if (discovery) svc.setMcpAuthDiscovery(discovery);
  return svc;
}
