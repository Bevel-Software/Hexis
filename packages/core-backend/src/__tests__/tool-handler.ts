import { createToolHandlerFactory } from '../modules/tool-helpers/tool-handler.js';
import type { ToolHandlerFactory } from '../modules/tool-helpers/index.js';

/**
 * The tool-handler factory, wired the way the composition root wires it
 * (`core/create-core-services.ts`) minus the write-access and branch ports a
 * suite about one tool's answer does not exercise. A module's suite that
 * mounts its tools takes the factory from HERE rather than constructing it
 * from `tool-helpers`' file: the factory is on no module entry (only its type
 * is — a handler factory arrives by injection), and this fixture stands in
 * for the root, as `real-disk.ts` does for the disk.
 */
export function toolHandlerFactory(resolve: Parameters<typeof createToolHandlerFactory>[0]): ToolHandlerFactory {
  return createToolHandlerFactory(resolve);
}
