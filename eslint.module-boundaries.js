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
// the same with `modules/` or `src/modules/` after one or two more `../`.
// One pattern per target module, so the message can name the entry to use.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = ['packages/core-backend', 'packages/core-frontend']
const DEEPEST = 6
/**
 * Packages whose files OUTSIDE `src/modules/` are held to the rule too. The
 * core frontend's shell (`core/`) and package entry (`index.ts`) mount the
 * modules through their indexes like any module does. The backend is not
 * listed: its composition root (`core/create-core-services.ts`) is the one
 * place the Module Map lets know every module's implementations at once.
 */
const SHELLS_HELD = ['packages/core-frontend']
const INDEX = '(?:index(?:\\.(?:js|jsx|ts|tsx))?$)'

/** Tests may reach into another module's internals for fixtures; the rule is about shipped code. */
export const MODULE_BOUNDARY_TEST_FILES = ['**/__tests__/**', '**/*.test.{ts,tsx}']

function modulesOf(root, pkg) {
  const dir = join(root, pkg, 'src', 'modules')
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory()).sort()
}

const ups = (n) => `(?:\\.\\./){${n}}`

/**
 * One pattern per target module, for specifiers that start with one of the
 * `leads` (alternatives, as regex source) into `modules/`.
 */
function boundaryPatterns(targets, leads) {
  return targets.map((other) => ({
    regex: `^(?:${leads})${other}/(?!${INDEX})`,
    caseSensitive: true,
    message:
      `Modular Domain-Driven Design: reach another module through its index — import from ` +
      `modules/${other}/index.ts, not its internals (export what you need from that index).`,
  }))
}

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
      for (let depth = 0; depth <= DEEPEST; depth++) {
        const patterns = boundaryPatterns(
          modules.filter((other) => other !== own),
          `${ups(depth + 1)}|${ups(depth + 2)}modules/|${ups(depth + 3)}src/modules/`,
        )
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
    if (!SHELLS_HELD.includes(pkg)) continue
    // The package's own files outside `modules/` (its shell, its entry): at
    // depth d below `src/`, d `../` (or `./` at the top) lead to `modules/`.
    for (let depth = 0; depth <= DEEPEST; depth++) {
      const patterns = boundaryPatterns(
        modules,
        `${depth === 0 ? '\\./' : ups(depth)}modules/|${ups(depth + 1)}src/modules/`,
      )
      blocks.push({
        name: `module-boundaries/${pkg.split('/')[1]}/outside-modules/depth-${depth}`,
        files: [`${pkg}/src/${'*/'.repeat(depth)}*.{ts,tsx}`],
        ignores: [`${pkg}/src/modules/**`, ...MODULE_BOUNDARY_TEST_FILES, ...Object.keys(exceptions)],
        rules: {
          'no-restricted-imports': ['error', { paths: paths[pkg] ?? [], patterns }],
        },
      })
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
}
