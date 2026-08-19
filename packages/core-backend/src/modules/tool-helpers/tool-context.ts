import { LocalFilesystem } from '@mastra/core/workspace';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import { LockingFilesystem } from '../kb-fs/locking-filesystem.js';
import { ReadOnlyFilesystem } from '../kb-fs/read-only-filesystem.js';
import { makeRolesYamlWriteValidator } from '../access-model/roles-yaml-guard.js';
import type { ICreatorAccess } from '../access/creator-access.js';
import { type WorkspaceService } from '../workspace/workspace.service.js';
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
  // Reject an agent write that would leave roles.yaml unparseable (app-wide
  // admin lockout) before it reaches disk — the agent gets a tool error and the
  // file is untouched, mirroring the human editor's save-time gate.
  const validateRolesWrite = makeRolesYamlWriteValidator(deps.kbDirName);

  return async function resolveToolContext(auth, abortSignal, sessionId) {
    const user = await deps.authService.getUserById(auth.userId);
    if (!user) throw new ToolError('Your account is no longer available.', 401);

    const fsCache = new Map<string, LocalFilesystem>();
    const getFilesystem = async (branch: string): Promise<LocalFilesystem> => {
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
                validateWrite: validateRolesWrite,
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
