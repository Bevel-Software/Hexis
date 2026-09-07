import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { PREAMBLE_FILE } from './compose.js';

/** The one reader both the hosted proxy and the agent-facing route call. */
export type AgentPreambleReader = () => Promise<string | null>;

/** The two workspace operations the reader needs, so a test can stand in for the service. */
export type PreambleWorkspace = Pick<WorkspaceService, 'getOrCreateForBranch' | 'readFile'>;

/**
 * The raw content of `mcp-description.md` on the default branch, read with
 * PLATFORM privileges: the root is default-deny for reads, and the preamble is
 * a broadcast the admin writes for every connected agent, so it is never read
 * as the caller. `null` only for an ABSENT file (ENOENT); any other failure
 * throws, so a disk fault never masquerades as "no preamble". The workspace is
 * created first when it does not exist yet, exactly as the plugin archive
 * route does.
 *
 * Inside the workspace the repository is the `<kbDirName>/` folder, so the
 * path is `${kbDirName}/mcp-description.md`, the same shape `SkillService` and
 * the archive route use.
 */
export async function readAgentPreamble(workspace: PreambleWorkspace, kbDirName: string): Promise<string | null> {
  await workspace.getOrCreateForBranch(DEFAULT_BRANCH);
  try {
    return await workspace.readFile(workspaceIdForBranch(DEFAULT_BRANCH), `${kbDirName}/${PREAMBLE_FILE}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}
