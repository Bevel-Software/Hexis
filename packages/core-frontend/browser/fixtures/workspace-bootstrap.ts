/**
 * The page entry `workspace-bootstrap-cache.browser.ts` bundles: the app's
 * real read of a branch's workspace, `getOrCreateWorkspace`, taken from the
 * workspace module's entry. Nothing stands in for it; the server it asks is
 * the test's.
 */
import { getOrCreateWorkspace, WorkspaceApiError } from '../../src/modules/workspace';

declare global {
  interface Window {
    /** The app's read of `branch`'s workspace, answered as `200 <id>` or `failed <status>`. */
    openBranch(branch: string): Promise<string>;
  }
}

window.openBranch = (branch) =>
  getOrCreateWorkspace(branch).then(
    ({ workspace }) => `200 ${workspace.id}`,
    (err: unknown) => `failed ${err instanceof WorkspaceApiError ? err.status : String(err)}`,
  );
