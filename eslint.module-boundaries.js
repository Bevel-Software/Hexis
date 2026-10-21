// Module boundaries, as `no-restricted-imports` patterns. Used by
// `eslint.config.js`; the reason for the rule is written there, next to the
// rule's other settings. This file holds the mechanics and the backlog.
//
// A pattern sees an import's specifier as written, not the file it resolves
// to, so the same `../audit/x.js` means another module from
// `modules/mcp/a.ts` and this module's own folder from `modules/mcp/oauth/b.ts`.
// The blocks are therefore cut per module AND per folder depth inside it (a
// flat-config `*` never crosses a `/`): at depth d, d+1 `../` lead out of the
// module into `modules/`, so `^(\.\./){d+1}<other>/` names another module, and
// so does any longer way round that climbs further and comes back down
// through a `modules/` folder. One pattern per target module, so the message
// can name the entry to use.
//
// Counting `../` only measures a path in normal form, so a relative specifier
// that is not (`./../x`, `a/../x`, `a/./x`, `a//x`) is refused in the same
// files: written plainly it is either allowed or named by the patterns above.
// The depths come from the tree at config load, one block per folder level
// each module actually has, so a new sub-folder is covered the day it lands.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = ['packages/core-backend', 'packages/core-frontend']
/** The module's public entry: its folder alone, or its `index` file. */
const INDEX = '(?:index(?:\\.(?:js|jsx|ts|tsx))?)?$'
/** A relative specifier with a `.` or `..` past its leading climb, or an empty segment. */
const NOT_NORMAL = '^(?=\\.\\.?/)(?:.*//|.*/\\.(?:/|$)|\\./\\.\\.?(?:/|$)|(?:.*/)?(?!\\.\\.?(?:/|$))[^/]+/\\.\\.(?:/|$))'

/** Tests may reach into another module's internals for fixtures; the rule is about shipped code. */
export const MODULE_BOUNDARY_TEST_FILES = ['**/__tests__/**', '**/*.test.{ts,tsx}']

const subdirs = (dir) => readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory())

function modulesOf(root, pkg) {
  return subdirs(join(root, pkg, 'src', 'modules')).sort()
}

/** How many folders deep the module's tree goes, its own folder being 0. */
function depthOf(dir) {
  return Math.max(0, ...subdirs(dir).map((name) => 1 + depthOf(join(dir, name))))
}

const ups = (n) => `(?:\\.\\./){${n}}`

/**
 * The flat-config blocks that enforce the rule. `paths` is merged into every
 * block's options, for packages whose files already carry a
 * `no-restricted-imports` `paths` list: a later block's options replace an
 * earlier one's, they do not add to them. `exceptions` maps repo-relative
 * files to the reason they are not yet held to the rule.
 */
export function moduleBoundaries({ root, exceptions = {}, paths = {} }) {
  const blocks = []
  for (const pkg of PACKAGES) {
    const modules = modulesOf(root, pkg)
    for (const own of modules) {
      const deepest = depthOf(join(root, pkg, 'src', 'modules', own))
      for (let depth = 0; depth <= deepest; depth++) {
        const patterns = [
          {
            regex: NOT_NORMAL,
            message:
              'Modular Domain-Driven Design: write a relative import in normal form (no `./..`, `a/..`, ' +
              '`/./` or `//`), so the module-boundary rule can see which module it reaches.',
          },
          ...modules
            .filter((other) => other !== own)
            .map((other) => ({
              regex: `^${ups(depth + 1)}(?:(?:\\.\\./)+(?:[^/]+/)*modules/)?${other}/(?!${INDEX})`,
              caseSensitive: true,
              message:
                `Modular Domain-Driven Design: reach another module through its index — import from ` +
                `modules/${other}/index.ts, not its internals (export what you need from that index).`,
            })),
        ]
        blocks.push({
          name: `module-boundaries/${pkg.split('/')[1]}/${own}/depth-${depth}`,
          files: [`${pkg}/src/modules/${own}/${'*/'.repeat(depth)}*.{ts,tsx}`],
          ignores: [...MODULE_BOUNDARY_TEST_FILES, ...Object.keys(exceptions)],
          rules: {
            'no-restricted-imports': ['error', { paths: paths[pkg] ?? [], patterns }],
          },
        })
      }
    }
  }
  return blocks
}

/**
 * Files not yet held to the rule, each with what it reaches for. This is the
 * backlog: fixing an entry means exporting what the file needs from the
 * target's `index.ts` (or giving the target one), importing it from there,
 * and deleting the line here. A new file never goes on this list.
 * `module-boundaries.lint.test.ts` (core-backend) fails on an entry that no
 * longer needs to be here.
 */
export const MODULE_BOUNDARY_EXCEPTIONS = {
  'packages/core-backend/src/modules/access/access-control.service.ts':
    'access-model has no index.ts; workflow/index.ts does not export NodeGitRunner; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/access/access-declarations.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/access/access-mutation.service.ts':
    'access-model has no index.ts; workspace/index.ts does not export WorkspaceService, isTextBytes',
  'packages/core-backend/src/modules/access/access-requests.contract.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/access/access-requests.routes.ts':
    'auth/index.ts does not export AuthService; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/access/access-requests.service.ts':
    'access-model has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/access/access-view.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/access/access.routes.ts':
    'access-model has no index.ts; auth/index.ts does not export AuthService, IAccountSwitchGuard; database has no index.ts; workflow/index.ts does not export WorkflowEventBus, WorkflowService; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/access/admin-locked-commit.ts':
    'kb-fs/index.ts does not export LockingFilesystem',
  'packages/core-backend/src/modules/access/capability-registry.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/access/change-read-gate.ts':
    'access-model has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/access/creator-access.ts':
    'access-model has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/access/directory-sync-bot.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/access/groups-admin.routes.ts':
    'access-model has no index.ts; admin has no index.ts',
  'packages/core-backend/src/modules/access/groups-admin.service.ts':
    'access-model has no index.ts; workflow/index.ts does not export WorkflowEventBus',
  'packages/core-backend/src/modules/access/groups-edit.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/access/reference-scan.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/access/roles-admin.service.ts':
    'access-model has no index.ts; workflow/index.ts does not export WorkflowEventBus',
  'packages/core-backend/src/modules/access/roles-edit.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/access/synced-groups-committer.ts':
    'access-model has no index.ts; kb-fs/index.ts does not export LockingFilesystem; workflow/index.ts does not export WorkflowEventBus; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/access/synced-groups-writer.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/access/user-access-removal.service.ts':
    'access-model has no index.ts; workflow/index.ts does not export WorkflowEventBus',
  'packages/core-backend/src/modules/admin/admin-access.service.ts':
    'access has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/agent-guide/agent-guide.tools.ts':
    'tool-helpers/index.ts does not export ToolHandlerFactory; tool-registry has no index.ts',
  'packages/core-backend/src/modules/agent-guide/index.ts':
    'tool-registry has no index.ts',
  'packages/core-backend/src/modules/agent-instructions/read-preamble.ts':
    'workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/audit/agent-audit.service.ts':
    'database has no index.ts; tool-auth has no index.ts',
  'packages/core-backend/src/modules/audit/agent-rest-audit.middleware.ts':
    'tool-auth has no index.ts',
  'packages/core-backend/src/modules/audit/audit.routes.ts':
    'admin has no index.ts; tool-auth has no index.ts',
  'packages/core-backend/src/modules/auth/account-erasure.service.ts':
    'database has no index.ts; workflow/index.ts does not export IReviewWorkflowService',
  'packages/core-backend/src/modules/auth/account-switch-lock.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/auth/account.routes.ts':
    'access has no index.ts; admin has no index.ts',
  'packages/core-backend/src/modules/auth/auth.service.ts':
    'access has no index.ts; database has no index.ts; workflow/index.ts does not export RECOVERY_BOT_EMAIL',
  'packages/core-backend/src/modules/auth/oidc-auth-provider.ts':
    'settings has no index.ts',
  'packages/core-backend/src/modules/code-mode/code-mode.tool.ts':
    'workspace/index.ts does not export SpillStore',
  'packages/core-backend/src/modules/connection-probe/connection-probe.service.ts':
    'tool-manuals/index.ts does not export ToolHealthCheck, ToolProbeTarget',
  'packages/core-backend/src/modules/diff/diff.routes.ts':
    'access has no index.ts; access-model has no index.ts; auth/index.ts does not export AuthService; kb-fs/index.ts does not export LockingFilesystem',
  'packages/core-backend/src/modules/diff/diff.service.ts':
    'kb-fs/index.ts does not export WorkspaceMutex; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/embed/account-link.service.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/embed/embed.service.ts':
    'access has no index.ts',
  'packages/core-backend/src/modules/embed/embed.tools.ts':
    'tool-auth has no index.ts; tool-helpers/index.ts does not export ToolHandlerFactory; tool-registry has no index.ts; workspace/index.ts does not export ReadForTool, SESSION_ID_INPUT, ToolDescriptionNotes and 1 more',
  'packages/core-backend/src/modules/github-app/github-app.connection.ts':
    'settings has no index.ts',
  'packages/core-backend/src/modules/github-app/github-app.routes.ts':
    'admin has no index.ts; settings has no index.ts',
  'packages/core-backend/src/modules/kb-fs/locking-filesystem.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/kb-sync/kb-sync.routes.ts':
    'admin has no index.ts; kb-fs/index.ts does not export assertValidBranchName',
  'packages/core-backend/src/modules/kb-sync/kb-sync.service.ts':
    'workflow/index.ts does not export sanitizeError',
  'packages/core-backend/src/modules/kb-sync/sync-payload.ts':
    'kb-fs/index.ts does not export assertValidBranchName',
  'packages/core-backend/src/modules/marketplace/git-http.routes.ts':
    'tool-auth has no index.ts',
  'packages/core-backend/src/modules/marketplace/github-facade/github-facade-codes.store.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/marketplace/github-facade/github-facade-credentials.service.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/marketplace/github-facade/github-facade.routes.ts':
    'tool-auth has no index.ts',
  'packages/core-backend/src/modules/marketplace/github-facade/github-facade.service.ts':
    'mcp has no index.ts; tool-auth has no index.ts',
  'packages/core-backend/src/modules/marketplace/marketplace-repo.service.ts':
    'kb-fs/index.ts does not export WorkspaceMutex',
  'packages/core-backend/src/modules/mcp/mcp-auth.middleware.ts':
    'auth/index.ts does not export AuthService; tool-auth has no index.ts',
  'packages/core-backend/src/modules/mcp/mcp.routes.ts':
    'tool-auth has no index.ts',
  'packages/core-backend/src/modules/mcp/mcp.service.ts':
    'secrets-vault/index.ts does not export scopesCovered; tool-auth has no index.ts; tool-registry has no index.ts; workspace/index.ts does not export SpillStore',
  'packages/core-backend/src/modules/mcp/oauth/bevel-oauth-provider.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/onboarding/starter-pack.service.ts':
    'access has no index.ts; admin has no index.ts; kb-fs/index.ts does not export FileChangeNotifier, LockingFilesystem, WorkspaceMutex; workspace/index.ts does not export FirstRunStarter, FirstRunStarterSource, MayRead and 2 more',
  'packages/core-backend/src/modules/plugins/compile/compile-marketplace.ts':
    'tool-manuals/index.ts does not export judgeMcpServerEntry',
  'packages/core-backend/src/modules/plugins/compile/marketplace-compiler.service.ts':
    'access has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/plugins/discovery/bundle-dialect/registry.ts':
    'tool-manuals/index.ts does not export PortableHttpEntry, PortableStdioEntry, judgeMcpServerEntry',
  'packages/core-backend/src/modules/plugins/join-proposals.ts':
    'access has no index.ts; access-model has no index.ts',
  'packages/core-backend/src/modules/plugins/join-request-jobs.service.ts':
    'access-model has no index.ts; workflow/index.ts does not export sanitizeError; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/plugins/join-request-records.store.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/plugins/join-requests.service.ts':
    'access has no index.ts; access-model has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/plugins/plugin-links.service.ts':
    'access has no index.ts; access-model has no index.ts; kb-fs/index.ts does not export WorkspaceMutex; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/plugins/plugin-links.ts':
    'access has no index.ts; access-model has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/plugins/plugin-provision.service.ts':
    'access has no index.ts; access-model has no index.ts; kb-fs/index.ts does not export WorkspaceMutex; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/plugins/plugin-rename.service.ts':
    'access has no index.ts; access-model has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/plugins/plugins.contract.ts':
    'skills/index.ts does not export PluginMembership',
  'packages/core-backend/src/modules/plugins/plugins.routes.ts':
    'access has no index.ts; tool-helpers/index.ts does not export argumentsRefusal',
  'packages/core-backend/src/modules/plugins/plugins.service.ts':
    'access has no index.ts; access-model has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/plugins/plugins.tools.ts':
    'tool-registry has no index.ts',
  'packages/core-backend/src/modules/plugins/teams.routes.ts':
    'access has no index.ts',
  'packages/core-backend/src/modules/secrets-vault/db-secrets-vault.service.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/secrets-vault/secrets-vault.routes.ts':
    'access has no index.ts; tool-manuals/index.ts does not export ToolVariable',
  'packages/core-backend/src/modules/settings/connection-check.ts':
    'workflow/index.ts does not export NodeGitRunner',
  'packages/core-backend/src/modules/settings/deployment-settings.service.ts':
    'database has no index.ts; kb-fs/index.ts does not export assertKbDirNameFree, hasControlCharacter',
  'packages/core-backend/src/modules/settings/git-root-folders.ts':
    'workflow/index.ts does not export NodeGitRunner',
  'packages/core-backend/src/modules/settings/setup.routes.ts':
    'admin has no index.ts; kb-fs/index.ts does not export sameRepository',
  'packages/core-backend/src/modules/skills/allowed-tools-check.ts':
    'tool-manuals/index.ts does not export MAX_CAPABILITIES; tool-registry has no index.ts',
  'packages/core-backend/src/modules/skills/pending-skills.service.ts':
    'access has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/skills/skill-access-requests.routes.ts':
    'access has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/skills/skills.service.ts':
    'access has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/skills/skills.tools.ts':
    'tool-helpers/index.ts does not export ToolHandlerFactory, bodyEnvelope, declareRouteTool; tool-registry has no index.ts',
  'packages/core-backend/src/modules/tool-auth/connection-keys-admin.routes.ts':
    'admin has no index.ts',
  'packages/core-backend/src/modules/tool-auth/external-api-key.service.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/tool-auth/tool-auth.middleware.ts':
    'auth/index.ts does not export AuthService',
  'packages/core-backend/src/modules/tool-helpers/default-branch-write.ts':
    'access has no index.ts',
  'packages/core-backend/src/modules/tool-helpers/index.ts':
    'tool-registry has no index.ts',
  'packages/core-backend/src/modules/tool-helpers/route-tool-schemas.ts':
    'tool-registry has no index.ts',
  'packages/core-backend/src/modules/tool-helpers/tool-context.ts':
    'access-model has no index.ts; auth/index.ts does not export AuthService; kb-fs/index.ts does not export LockingFilesystem, ReadOnlyFilesystem; tool-auth has no index.ts; workflow/index.ts does not export WorkflowEventBus; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/tool-helpers/tool-def.ts':
    'tool-registry has no index.ts',
  'packages/core-backend/src/modules/tool-helpers/tool-handler.ts':
    'tool-auth has no index.ts; write-access has no index.ts',
  'packages/core-backend/src/modules/tool-helpers/tool.contract.ts':
    'workflow/index.ts does not export WorkflowEventBus; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/tool-helpers/validate-token.ts':
    'tool-auth has no index.ts',
  'packages/core-backend/src/modules/tool-manuals/mcp-server-edit.service.ts':
    'access has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/tool-manuals/pending-tools.service.ts':
    'access has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/tool-manuals/tool-delete.service.ts':
    'access has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/tool-manuals/tool-manuals.routes.ts':
    'access has no index.ts; tool-auth has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/tool-manuals/tool-manuals.service.ts':
    'access has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/tool-manuals/tool-manuals.tools.ts':
    'access has no index.ts; tool-helpers/index.ts does not export ToolHandlerFactory, declareRouteTool; tool-registry has no index.ts',
  'packages/core-backend/src/modules/tool-registry/manual.routes.ts':
    'tool-auth has no index.ts',
  'packages/core-backend/src/modules/update-check/update-check.routes.ts':
    'admin has no index.ts',
  'packages/core-backend/src/modules/workflow/agent-tools/change-request-read.tools.ts':
    'access has no index.ts; tool-helpers/index.ts does not export ToolHandlerFactory; tool-registry has no index.ts',
  'packages/core-backend/src/modules/workflow/agent-tools/workflow.tools.ts':
    'access has no index.ts; kb-fs/index.ts does not export assertInsideRepo, normalizePathArgs; tool-auth has no index.ts; tool-helpers/index.ts does not export ToolHandlerFactory; tool-registry has no index.ts; workspace/index.ts does not export AgentAccessGate, SESSION_ID_INPUT, assertAgentWriteAllowed and 1 more',
  'packages/core-backend/src/modules/workflow/file-lock.service.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/workflow/git/git.service.ts':
    'access has no index.ts; access-model has no index.ts; kb-fs/index.ts does not export SAFE_IMPLICIT_FETCH_ARGS, WorkspaceMutex, assertInsideRepo and 5 more; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/workflow/git/node-git-runner.ts':
    'kb-fs/index.ts does not export credentialHelperValue',
  'packages/core-backend/src/modules/workflow/git/pull-request.service.ts':
    'access has no index.ts; access-model has no index.ts; database has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/workflow/pending-commits.service.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/workflow/read-on-branch.ts':
    'access has no index.ts',
  'packages/core-backend/src/modules/workflow/recovery-bot.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/workflow/review-workflow/approval-lock.ts':
    'database has no index.ts',
  'packages/core-backend/src/modules/workflow/review-workflow/review-workflow.service.ts':
    'access has no index.ts; access-model has no index.ts; database has no index.ts; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/workflow/workflow.routes.ts':
    'access has no index.ts; access-model has no index.ts; auth/index.ts does not export AuthService; kb-fs/index.ts does not export assertValidRelativePath; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/workflow/workflow.service.ts':
    'access has no index.ts; access-model has no index.ts; database has no index.ts; kb-fs/index.ts does not export FileChangeNotifier, WorkspaceMutex, assertValidBranchName; workspace/index.ts does not export WorkspaceService',
  'packages/core-backend/src/modules/workspace/agent-access.gate.ts':
    'tool-registry has no index.ts; workflow/index.ts does not export WorkflowHooks',
  'packages/core-backend/src/modules/workspace/first-run.ts':
    'kb-fs/index.ts does not export BevelIgnoreStack',
  'packages/core-backend/src/modules/workspace/kb-repository.ts':
    'kb-fs/index.ts does not export ORIGIN_FETCH_REFSPEC, SAFE_IMPLICIT_FETCH_ARGS, cloneCredentialConfigArgs and 1 more',
  'packages/core-backend/src/modules/workspace/startup/kb-git.ts':
    'kb-fs/index.ts does not export cloneCredentialArgs, credentialHelperValue',
  'packages/core-backend/src/modules/workspace/startup/kb-startup-runner.ts':
    'kb-fs/index.ts does not export assertValidBranchName, normalizeRepositoryAddress, sameRepository',
  'packages/core-backend/src/modules/workspace/startup/steps/groups-to-plugins.step.ts':
    'access-model has no index.ts; tool-manuals/index.ts does not export ToolManualDescriptor, normalizeToolManual',
  'packages/core-backend/src/modules/workspace/startup/steps/personal-spaces.step.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/workspace/startup/steps/plugin-layout.ts':
    'plugins/index.ts does not export BUNDLE_FILE',
  'packages/core-backend/src/modules/workspace/startup/steps/roles-yaml.step.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/workspace/startup/steps/seed-tree.ts':
    'access-model has no index.ts',
  'packages/core-backend/src/modules/workspace/workspace.routes.ts':
    'access has no index.ts; access-model has no index.ts; admin has no index.ts; auth/index.ts does not export AuthService; kb-fs/index.ts does not export normalizeWorkspacePath; workflow/index.ts does not export WorkflowEventBus',
  'packages/core-backend/src/modules/workspace/workspace.service.ts':
    'diff has no index.ts; kb-fs/index.ts does not export BevelIgnoreStack, SAFE_IMPLICIT_FETCH_ARGS, assertRepoRootNameFree and 7 more; workflow/index.ts does not export NodeGitRunner',
  'packages/core-backend/src/modules/workspace/workspace.tools.ts':
    'access has no index.ts; access-model has no index.ts; kb-fs/index.ts does not export GitGuardedFilesystem, LockingFilesystem, MoveLockedError and 7 more; tool-auth has no index.ts; tool-helpers/index.ts does not export ToolHandlerFactory; tool-registry has no index.ts',
  'packages/core-backend/src/modules/workspace/write-denial.ts':
    'access has no index.ts; access-model has no index.ts',
  'packages/core-frontend/src/modules/access/api.ts':
    'git/index.ts does not export GitApiError, handleApiResponse',
  'packages/core-frontend/src/modules/access/components/ManageAccessDialog.tsx':
    'admin has no index.ts; auth has no index.ts; onboarding has no index.ts; workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/access/hooks/useAccessRequests.ts':
    'pr has no index.ts',
  'packages/core-frontend/src/modules/access/hooks/useFileAccess.ts':
    'workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/access/requests.api.ts':
    'git/index.ts does not export handleApiResponse',
  'packages/core-frontend/src/modules/admin/components/AddMemberInput.tsx':
    'access has no index.ts',
  'packages/core-frontend/src/modules/admin/components/UserAccountsPage.tsx':
    'auth has no index.ts; onboarding has no index.ts',
  'packages/core-frontend/src/modules/admin/state/admin.context.tsx':
    'auth has no index.ts',
  'packages/core-frontend/src/modules/audit/components/AuditEventsPanel.tsx':
    'library/index.ts does not export pathForSkill',
  'packages/core-frontend/src/modules/audit/components/AuditLogPage.tsx':
    'admin has no index.ts; auth has no index.ts',
  'packages/core-frontend/src/modules/change-requests/components/BranchFilePreview.tsx':
    'access has no index.ts; workspace/index.ts does not export DownloadFileButton, FilePaneCard, READ_PANE and 4 more',
  'packages/core-frontend/src/modules/change-requests/components/ChangeRequestDialog.tsx':
    'auth has no index.ts; git/index.ts does not export GitApiError, GitSyncFailedBanner, friendlyGitError and 1 more; pr has no index.ts; review has no index.ts; workflow/index.ts does not export useEventBus; workspace/index.ts does not export WorkspaceApiError, hasFileViewer, isBinaryFile and 1 more',
  'packages/core-frontend/src/modules/change-requests/components/ChangeRequestLink.tsx':
    'git/index.ts does not export GitApiError, getPullRequest; workspace/index.ts does not export KB_ROUTE_PREFIX',
  'packages/core-frontend/src/modules/change-requests/components/CrFileTree.tsx':
    'workspace/index.ts does not export displayFileName',
  'packages/core-frontend/src/modules/change-requests/components/FileChangeBoxes.tsx':
    'pr has no index.ts; workspace/index.ts does not export displayFileName, fileNameTooltip, isBinaryFile and 1 more',
  'packages/core-frontend/src/modules/change-requests/hooks/useApplyChangeRequest.ts':
    'git/index.ts does not export friendlyGitError, friendlyGitMessage; pr has no index.ts; workflow/index.ts does not export useEventBus',
  'packages/core-frontend/src/modules/change-requests/hooks/useCrFileDiffs.ts':
    'workspace/index.ts does not export WorkspaceApiError, isBinaryFile',
  'packages/core-frontend/src/modules/change-requests/services/change-requests.api.ts':
    'git/index.ts does not export handleApiResponse; workspace/index.ts does not export getOrCreateWorkspace, readFile',
  'packages/core-frontend/src/modules/change-requests/services/denied-file.api.ts':
    'access has no index.ts; workspace/index.ts does not export getOrCreateWorkspace',
  'packages/core-frontend/src/modules/change-requests/services/propose.api.ts':
    'git/index.ts does not export GitApiError, createBranch, deleteBranch; pr has no index.ts; workspace/index.ts does not export getOrCreateWorkspace, writeFile',
  'packages/core-frontend/src/modules/change-requests/utils/diff.ts':
    'workspace/index.ts does not export computeDiff',
  'packages/core-frontend/src/modules/change-requests/utils/readFailure.ts':
    'access has no index.ts',
  'packages/core-frontend/src/modules/embed/components/EmbedLinkPage.tsx':
    'auth has no index.ts',
  'packages/core-frontend/src/modules/git/components/BranchSwitcher.tsx':
    'access has no index.ts; auth has no index.ts; workspace/index.ts does not export KB_ROUTE_PREFIX, useWorkspace',
  'packages/core-frontend/src/modules/git/components/FileHistoryPanel.tsx':
    'review has no index.ts; workflow/index.ts does not export canonicalizeWorkspaceId, useEventBus; workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/git/components/GitSyncFailedBanner.tsx':
    'workflow/index.ts does not export canonicalizeWorkspaceId, useEventBusSubscription; workspace/index.ts does not export WorkspaceContext, useFileNav, useWorkspace',
  'packages/core-frontend/src/modules/git/components/HistoryVersionPreview.tsx':
    'access has no index.ts; workspace/index.ts does not export DownloadFileButton, FilePaneCard, READ_PANE and 10 more',
  'packages/core-frontend/src/modules/git/components/PullNeededBanner.tsx':
    'workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/git/components/PullRequestsForMe.tsx':
    'change-requests has no index.ts; layout has no index.ts',
  'packages/core-frontend/src/modules/git/hooks/useAutoPullUpdates.ts':
    'workspace/index.ts does not export WorkspaceContextValue',
  'packages/core-frontend/src/modules/layout/components/MobileChatLayout.tsx':
    'workspace/index.ts does not export KB_ROUTE_PREFIX',
  'packages/core-frontend/src/modules/library/components/AddToPluginDialog.tsx':
    'admin has no index.ts',
  'packages/core-frontend/src/modules/library/components/ChangeRequestDock.tsx':
    'change-requests has no index.ts',
  'packages/core-frontend/src/modules/library/components/IntegrationsSetupReminder.tsx':
    'layout has no index.ts',
  'packages/core-frontend/src/modules/library/components/LibraryLayout.tsx':
    'admin has no index.ts; git/index.ts does not export PullRequestsForMe; layout has no index.ts; onboarding has no index.ts',
  'packages/core-frontend/src/modules/library/components/LibraryPage.tsx':
    'access has no index.ts; admin has no index.ts; onboarding has no index.ts; workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/library/components/ManagedPluginRequests.tsx':
    'access has no index.ts; workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/library/components/NewSkillPanel.tsx':
    'auth has no index.ts',
  'packages/core-frontend/src/modules/library/components/PendingItemReview.tsx':
    'change-requests has no index.ts',
  'packages/core-frontend/src/modules/library/components/PersonalAddDialog.tsx':
    'admin has no index.ts',
  'packages/core-frontend/src/modules/library/components/PersonalPluginPage.tsx':
    'access has no index.ts; workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/library/components/PluginExtras.tsx':
    'workspace/index.ts does not export checkoutRoot, listFiles, readFile and 1 more',
  'packages/core-frontend/src/modules/library/components/PluginJoinRequests.tsx':
    'access has no index.ts',
  'packages/core-frontend/src/modules/library/components/PluginPage.tsx':
    'access has no index.ts; workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/library/components/PluginRows.tsx':
    'admin has no index.ts',
  'packages/core-frontend/src/modules/library/components/PluginsSidebar.tsx':
    'layout has no index.ts',
  'packages/core-frontend/src/modules/library/components/SkillsTree.tsx':
    'workspace/index.ts does not export EmptyTreeNotice, FileTreeNode, KB_ROUTE_PREFIX and 9 more',
  'packages/core-frontend/src/modules/library/components/plugin-page-parts.tsx':
    'admin has no index.ts',
  'packages/core-frontend/src/modules/library/components/skill-page/SkillFilePane.tsx':
    'change-requests has no index.ts; workspace/index.ts does not export FilePaneCard, HtmlRenderer, KbImageResolver and 1 more',
  'packages/core-frontend/src/modules/library/components/skill-page/SkillPage.tsx':
    'access has no index.ts; auth has no index.ts; change-requests has no index.ts; git/index.ts does not export FileHistoryPanel, useGit; pr has no index.ts; workspace/index.ts does not export SkillToolWarning, getOrCreateWorkspace, isBinaryFile and 5 more',
  'packages/core-frontend/src/modules/library/components/tool-page/ToolConnectionSection.tsx':
    'secrets-vault/index.ts does not export ToolSecrets, useSavedKeyProbe; workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/library/components/tool-page/ToolVarRow.tsx':
    'secrets-vault/index.ts does not export ToolVarStatus, deleteAdminVar, setAdminVar and 3 more',
  'packages/core-frontend/src/modules/library/hooks/useJoinRequests.ts':
    'access has no index.ts',
  'packages/core-frontend/src/modules/library/hooks/useLibraryData.ts':
    'access has no index.ts; change-requests has no index.ts; secrets-vault/index.ts does not export ToolSecrets, listToolSecrets',
  'packages/core-frontend/src/modules/library/hooks/useToolPage.ts':
    'secrets-vault/index.ts does not export ToolSecrets, listToolSecrets',
  'packages/core-frontend/src/modules/library/hooks/useToolSource.ts':
    'change-requests has no index.ts',
  'packages/core-frontend/src/modules/library/routes/LibraryRoutes.tsx':
    'onboarding has no index.ts; workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/library/routes/WorkspaceItemRoute.tsx':
    'workspace/index.ts does not export FileRoute, safeDecode, useWorkspace',
  'packages/core-frontend/src/modules/library/services/library.api.ts':
    'change-requests has no index.ts; git/index.ts does not export createBranch, handleApiResponse; pr has no index.ts; workspace/index.ts does not export SkillToolWarning, deleteFile, getOrCreateWorkspace and 1 more',
  'packages/core-frontend/src/modules/library/services/plugins.api.ts':
    'git/index.ts does not export handleApiResponse',
  'packages/core-frontend/src/modules/library/services/teams.api.ts':
    'git/index.ts does not export handleApiResponse',
  'packages/core-frontend/src/modules/library/utils/status.ts':
    'secrets-vault/index.ts does not export ProbeVerdict, ToolSecrets, ToolVarStatus and 1 more',
  'packages/core-frontend/src/modules/onboarding/components/ConnectAgentPill.tsx':
    'library/index.ts does not export useLibraryToast',
  'packages/core-frontend/src/modules/onboarding/components/CreatorWelcomePage.tsx':
    'auth has no index.ts; library/index.ts does not export NewPluginDialog, NewSkillPanel, displayFirstName and 1 more',
  'packages/core-frontend/src/modules/onboarding/components/GetStartedColumn.tsx':
    'admin has no index.ts; auth has no index.ts; layout has no index.ts; library/index.ts does not export LIBRARY_ROOT, PluginSummary, isLibraryLocation and 2 more; toolbar has no index.ts; workspace/index.ts does not export findEntryByPath, pathExistsInTree, useCreatePage and 3 more',
  'packages/core-frontend/src/modules/onboarding/components/InviteButton.tsx':
    'access has no index.ts; admin has no index.ts',
  'packages/core-frontend/src/modules/onboarding/components/InviteDialog.tsx':
    'admin has no index.ts; auth has no index.ts; library/index.ts does not export copyToClipboard',
  'packages/core-frontend/src/modules/onboarding/components/RootLanding.tsx':
    'auth has no index.ts; workspace/index.ts does not export KB_ROUTE_PREFIX',
  'packages/core-frontend/src/modules/onboarding/components/StarterPackCard.tsx':
    'workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/onboarding/components/WelcomePage.tsx':
    'auth has no index.ts; library/index.ts does not export COPY_FAILED_TOAST, copyToClipboard, displayFirstName and 2 more',
  'packages/core-frontend/src/modules/onboarding/paths.ts':
    'library/index.ts does not export LIBRARY_ROOT',
  'packages/core-frontend/src/modules/onboarding/state/agent-connection.ts':
    'auth has no index.ts; workflow/index.ts does not export useEventBus',
  'packages/core-frontend/src/modules/onboarding/state/onboarding.ts':
    'auth has no index.ts',
  'packages/core-frontend/src/modules/onboarding/state/starter-packs.ts':
    'auth has no index.ts',
  'packages/core-frontend/src/modules/pr/components/OpenChangeRequestDialog.tsx':
    'git/index.ts does not export useGit',
  'packages/core-frontend/src/modules/pr/services/pr-approvals.api.ts':
    'git/index.ts does not export handleApiResponse',
  'packages/core-frontend/src/modules/pr/services/pr-cancel.api.ts':
    'git/index.ts does not export handleApiResponse',
  'packages/core-frontend/src/modules/pr/services/pr-comments.api.ts':
    'git/index.ts does not export handleApiResponse',
  'packages/core-frontend/src/modules/pr/services/pr-detail.api.ts':
    'git/index.ts does not export handleApiResponse',
  'packages/core-frontend/src/modules/pr/services/pr-merge.api.ts':
    'git/index.ts does not export handleApiResponse',
  'packages/core-frontend/src/modules/pr/services/pr-open.api.ts':
    'git/index.ts does not export handleApiResponse',
  'packages/core-frontend/src/modules/review/components/DiffViewer.tsx':
    'workspace/index.ts does not export DiffLine, computeDiff',
  'packages/core-frontend/src/modules/review/components/MarkdownDiffViewer.tsx':
    'workspace/index.ts does not export DiffLine, FrontmatterData, KB_DIFF_REHYPE_PLUGINS and 6 more',
  'packages/core-frontend/src/modules/review/components/ReviewPanel.tsx':
    'workspace/index.ts does not export stripJunkBeforeKbDir, useFileNav, useNodeIdNav and 2 more',
  'packages/core-frontend/src/modules/review/state/ReviewProvider.tsx':
    'git/index.ts does not export useGit; workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/settings/components/DeploymentPage.tsx':
    'admin has no index.ts; setup has no index.ts',
  'packages/core-frontend/src/modules/settings/components/MarketplaceSection.tsx':
    'toolbar has no index.ts',
  'packages/core-frontend/src/modules/settings/components/SettingsLayout.tsx':
    'admin has no index.ts; layout has no index.ts',
  'packages/core-frontend/src/modules/setup/components/FirstRunStorage.tsx':
    'workspace/index.ts does not export KB_ROUTE_PREFIX',
  'packages/core-frontend/src/modules/setup/components/SetupScreen.tsx':
    'settings has no index.ts',
  'packages/core-frontend/src/modules/toolbar/commands/actions.tsx':
    'onboarding has no index.ts; settings has no index.ts',
  'packages/core-frontend/src/modules/toolbar/commands/useCommandActions.ts':
    'admin has no index.ts; auth has no index.ts; onboarding has no index.ts; settings has no index.ts; workspace/index.ts does not export useCreatePage, useEditablePage, useFileNav and 1 more',
  'packages/core-frontend/src/modules/toolbar/components/AgentInstructionsCard.tsx':
    'admin has no index.ts; workspace/index.ts does not export WorkspaceContext',
  'packages/core-frontend/src/modules/toolbar/components/AppSwitcher.tsx':
    'layout has no index.ts',
  'packages/core-frontend/src/modules/toolbar/components/ClaudeRegistrationSteps.tsx':
    'settings has no index.ts',
  'packages/core-frontend/src/modules/toolbar/components/CoworkSetupSteps.tsx':
    'settings has no index.ts',
  'packages/core-frontend/src/modules/toolbar/components/ExternalAgentAccessPage.tsx':
    'admin has no index.ts',
  'packages/core-frontend/src/modules/toolbar/components/ProfileMenu.tsx':
    'admin has no index.ts; auth has no index.ts; settings has no index.ts',
  'packages/core-frontend/src/modules/toolbar/components/SearchPalette.tsx':
    'library/index.ts does not export listPlugins, listSkills; onboarding has no index.ts; secrets-vault/index.ts does not export listToolSecrets; workspace/index.ts does not export knowledgeFiles, useFileNav, useMergedWorkspaceTree and 1 more',
  'packages/core-frontend/src/modules/toolbar/components/Toolbar.tsx':
    'layout has no index.ts; onboarding has no index.ts; settings has no index.ts',
  'packages/core-frontend/src/modules/toolbar/search/sources.ts':
    'library/index.ts does not export LibrarySkillSummary, PERSONAL_PLUGIN_NAME, PluginSummary and 4 more; secrets-vault/index.ts does not export ToolSecrets; workspace/index.ts does not export displayFileName',
  'packages/core-frontend/src/modules/toolbar/services/agent-instructions.api.ts':
    'workspace/index.ts does not export WorkspaceApiError, getOrCreateWorkspace, readFile and 1 more',
  'packages/core-frontend/src/modules/workflow/state/EventBusFocusBinder.tsx':
    'workspace/index.ts does not export useWorkspace',
  'packages/core-frontend/src/modules/workspace/components/FileExplorer.tsx':
    'access has no index.ts; admin has no index.ts; change-requests has no index.ts; pr has no index.ts',
  'packages/core-frontend/src/modules/workspace/components/FileRoute.tsx':
    'git/index.ts does not export useGit',
  'packages/core-frontend/src/modules/workspace/components/FileViewer.tsx':
    'access has no index.ts; auth has no index.ts; change-requests has no index.ts; git/index.ts does not export FileComparisonPanel, FileHistoryPanel, GitSyncFailedBanner and 2 more; layout has no index.ts; onboarding has no index.ts',
  'packages/core-frontend/src/modules/workspace/components/KbFileRail.tsx':
    'access has no index.ts',
  'packages/core-frontend/src/modules/workspace/components/renderers/ToolRenderer.tsx':
    'secrets-vault/index.ts does not export ToolSecrets, ToolSecretsPanel, listToolSecrets',
  'packages/core-frontend/src/modules/workspace/hooks/useImageRevision.ts':
    'workflow/index.ts does not export canonicalizeWorkspaceId, useEventBus',
  'packages/core-frontend/src/modules/workspace/hooks/useKnowledgeWriteTarget.ts':
    'access has no index.ts',
  'packages/core-frontend/src/modules/workspace/hooks/useLastCommit.ts':
    'git/index.ts does not export useGit',
  'packages/core-frontend/src/modules/workspace/hooks/useWorkspaceState.ts':
    'access has no index.ts; auth has no index.ts; change-requests has no index.ts; workflow/index.ts does not export canonicalizeWorkspaceId, useEventBus',
  'packages/core-frontend/src/modules/workspace/routing/kb-routes.ts':
    'git/index.ts does not export GitContext',
  'packages/core-frontend/src/modules/workspace/state/open-change-requests.tsx':
    'change-requests has no index.ts',
  'packages/core-frontend/src/modules/workspace/utils/treeConfirm.ts':
    'access has no index.ts',
}
