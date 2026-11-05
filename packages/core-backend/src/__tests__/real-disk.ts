import { NodeFs } from '../modules/kb-fs/node-fs.js';
import { KbPluginSource } from '../modules/plugins/index.js';
import type { KbContext } from '../shared/kb-context.js';

/**
 * The real disk, and the plugin source that reads it, wired the way the
 * composition root wires them (`core/create-core-services.ts`: one `NodeFs`,
 * one `KbPluginSource` over it). A module's suite that drives its service over
 * real files takes them from HERE rather than constructing another module's
 * implementation itself: the root is the one place that knows those files
 * (`NodeFs` is on no module entry, by design — a filesystem arrives by
 * injection), and this fixture stands in for the root, as `kb-context.ts`
 * does for the knowledge-base context.
 */
export function realDisk(): NodeFs {
  return new NodeFs();
}

export function realPluginSource(disk: NodeFs, kb: KbContext): KbPluginSource {
  return new KbPluginSource(disk, kb);
}
