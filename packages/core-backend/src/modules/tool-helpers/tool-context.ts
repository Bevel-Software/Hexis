import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalFilesystem } from '@mastra/core/workspace';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import { LockingFilesystem } from '../kb-fs/locking-filesystem.js';
import { ReadOnlyFilesystem } from '../kb-fs/read-only-filesystem.js';
import {
  makeAgentRolesYamlWriteValidator,
  ROLES_YAML_BASENAME,
} from '../access-model/roles-yaml-guard.js';
import type { ICreatorAccess } from '../access-model/creator.js';
import type { GroupsIndex } from '../access-model/group-files.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { isAbsence } from '../../shared/fs.contract.js';
import { assertBranchProvided } from '../../shared/domain-errors.js';
import { branchForWorkspaceId } from '../../shared/workspace-id.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';
import type { AuthService } from '../auth/auth.service.js';
import { ToolError, type ToolContext } from './tool.contract.js';
import type { ToolAuth } from '../tool-auth/tool-auth.middleware.js';

export interface ToolContextDeps {
  authService: AuthService;
  workspaceService: WorkspaceService;
  workflowService: IWorkflowService;
  events: WorkflowEventBus;
  /** KB dir name — used to recognise (and validate) writes to `roles.yaml`. */
  kbDirName: string;
  /**
   * Creator read-grant planner, threaded into the LockingFilesystem so agent
   * creations in unreadable spots stay visible to the driving user (see
   * `modules/access/creator-access`).
   */
  creatorAccess: ICreatorAccess;
  /**
   * The resolver's active-group-source loader (`loadActiveGroups` in
   * `modules/access`), injected so an agent's `roles.yaml` write adding a
   * `- group:<Name>` entry is checked against the groups on that branch.
   * Absent → group entries go unchecked.
   */
  loadActiveGroups?: (
    read: (filename: string) => Promise<string | null>,
  ) => Promise<{ groups: GroupsIndex; sourceFile: string; health: { ok: boolean } }>;
}

/** A file's text, or null when it does not exist. Any other failure throws. */
async function readTextIfExists(absolutePath: string): Promise<string | null> {
  try {
    return await fs.readFile(absolutePath, 'utf-8');
  } catch (err) {
    if (isAbsence(err)) return null;
    throw err;
  }
}

export type ResolveToolContext = (
  auth: ToolAuth,
  abortSignal: AbortSignal,
  sessionId?: string,
) => Promise<ToolContext>;

/**
 * Build the per-call `ToolContext` from a verified `ToolAuth`. Identity (user,
 * scope, source) is resolved up front; the WORKSPACE is resolved on demand by
 * `getFilesystem(branch)` and cached per branch. Internal and external callers
 * are identical — the credential is identity-only, so the workspace always comes
 * from the `branch` the tool passes (`getOrCreateForUser` clones the per-branch
 * workspace if needed). A tool that never touches the KB never calls
 * `getFilesystem`, so it resolves no workspace. Writes through the
 * LockingFilesystem auto-commit+push as `user`. Framework-agnostic — never reads
 * a request body; `branch` arrives as an explicit argument from the tool.
 */
export function createToolContextResolver(deps: ToolContextDeps): ResolveToolContext {
  return async function resolveToolContext(auth, abortSignal, sessionId) {
    const user = await deps.authService.getUserById(auth.userId);
    if (!user) throw new ToolError('Your account is no longer available.', 401);

    const { loadActiveGroups } = deps;
    const fsCache = new Map<string, LocalFilesystem>();
    const getFilesystem = async (branch: string): Promise<LocalFilesystem> => {
      // THE choke point: every knowledge-base tool resolves its workspace
      // through here, and a `call_tool_chain` call reaches the very same route
      // over loopback — so refusing a branch-less call here refuses it on both
      // paths at once, with no per-tool guard to keep in step.
      //
      // Before ANY workspace work, because both things downstream do with this
      // value are wrong when it is absent: `getOrCreateForUser` defaults a
      // missing branch to the deployment's default (protected) branch, so an
      // omitted argument would silently act on `main`; and a present-but-absent
      // value like the string "undefined" goes to `workspaceIdForBranch`, which
      // makes it a workspace directory of that name and then tries to clone a
      // branch nobody ever pushed. Failing closed here means no workspace is
      // created and no clone is attempted.
      assertBranchProvided(branch);
      const cached = fsCache.get(branch);
      if (cached) return cached;
      const ws = await deps.workspaceService.getOrCreateForUser(user, branch);
      const workspaceId = ws.id;
      const basePath = await deps.workspaceService.getWorkspacePath(workspaceId);
      const fs =
        auth.scope === 'write'
          ? new LockingFilesystem(
              { basePath, contained: true },
              {
                workflow: deps.workflowService,
                workspaceId,
                branch: branchForWorkspaceId(workspaceId),
                user,
                kbDirName: deps.kbDirName,
                // Reject an agent write that would leave roles.yaml unparseable
                // (app-wide admin lockout) or that creates a role before it
                // reaches disk, or that adds a `- group:` entry naming no group
                // — the agent gets a tool error and the file is untouched.
                // Agents manage membership; roles are pre-set.
                validateWrite: makeAgentRolesYamlWriteValidator(
                  deps.kbDirName,
                  () => readTextIfExists(path.join(basePath, deps.kbDirName, ROLES_YAML_BASENAME)),
                  loadActiveGroups &&
                    (async () => {
                      // A source that exists but cannot be read leaves group
                      // entries unchecked rather than refusing every one.
                      const active = await loadActiveGroups((file) =>
                        readTextIfExists(path.join(basePath, deps.kbDirName, file)),
                      );
                      return active.health.ok ? active : null;
                    }),
                ),
                creatorAccess: deps.creatorAccess,
              },
            )
          : new ReadOnlyFilesystem({ basePath, contained: true });
      fsCache.set(branch, fs);
      return fs;
    };

    return {
      user,
      scope: auth.scope,
      source: auth.source,
      tokenId: auth.tokenId,
      // For `internal` callers the signed token claim is the ONLY trustworthy
      // session: honoring a body value would let one per-run token switch to a
      // fresh `sessionId` and shed its accumulated touched-set. The body path is
      // only for `external`/`session` callers, whose token carries no claim and
      // whose `sessionId` is injected by the MCP proxy's continuity convention.
      sessionId: auth.source === 'internal' ? auth.sessionId : sessionId ?? auth.sessionId,
      // Only a trusted internal token conveys a focused branch; an external
      // caller (connection key / MCP proxy) never does and must name the branch
      // on every workspace tool. So a tool's focused-branch fallback is confined
      // to the in-process agent — external calls keep failing closed on a missing
      // branch, exactly as the required-branch contract demands.
      focusedBranch: auth.source === 'internal' ? auth.focusedBranch : undefined,
      abortSignal,
      workspaceService: deps.workspaceService,
      workflowService: deps.workflowService,
      events: deps.events,
      getFilesystem,
    };
  };
}
