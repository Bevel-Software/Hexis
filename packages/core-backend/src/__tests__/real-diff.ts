/**
 * The diff service and its routes, as the composition root wires them
 * (`core/create-core-services.ts`). A suite outside the diff module that runs
 * the real diff takes them from HERE: neither is on the module entry, by
 * design (a module receives the diff service by injection), and this fixture
 * stands in for the root, as `real-disk.ts` does for the disk.
 */
export { DiffService } from '../modules/diff/diff.service.js';
export { createDiffRoutes } from '../modules/diff/diff.routes.js';
