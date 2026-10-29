---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The git collaboration layer (branches, commits, file locks, the pending-commits queue, change requests, review and the event bus) is now the `version-control` module, so "workflow" is free for the Agents app. No alias is shipped: importers of the old paths and names must update.

Moved paths:

- `@bevel-software/platform-core-backend/modules/workflow/*` is `modules/version-control/*`. Files that carried the word are renamed too: `workflow.service.js` is `version-control.service.js`, `workflow-hooks.js` is `version-control-hooks.js`, `workflow.routes.js` is `version-control.routes.js`, `agent-tools/workflow.tools.js` is `agent-tools/version-control.tools.js`, and `review-workflow/review-workflow.{service,interface}.js` is `change-request-review/change-request-review.{service,interface}.js`.
- `packages/shared/src/workflow/` is `packages/shared/src/version-control/`. The shared package root exports the same names as before, renamed as below.
- `@bevel-software/platform-core-frontend/src/modules/workflow/` is `src/modules/version-control/`. Its `index.ts` exports the same hooks and services.

Renamed symbols:

- shared: `IWorkflowService` is `IVersionControlService`; `WorkflowEvent`, `WorkflowEventEnvelope` and `WorkflowEventPayload` are `VersionControlEvent`, `VersionControlEventEnvelope` and `VersionControlEventPayload`.
- core-backend: `WorkflowService` is `VersionControlService`, `WorkflowHooks` is `VersionControlHooks`, `WorkflowEventBus` is `VersionControlEventBus`, `ReviewWorkflowService` and `IReviewWorkflowService` are `ChangeRequestReviewService` and `IChangeRequestReviewService`, `createWorkflowRoutes` is `createVersionControlRoutes`, `registerWorkflowTools` is `registerVersionControlTools`, `WorkflowCommitDriver` is `VersionControlCommitDriver`, and `SyncWorkflowPort` is `SyncVersionControlPort`.
- core-backend errors (`shared/domain-errors.js`): `WorkflowDomainError`, `WorkflowValidationError` and `NotImplementedWorkflowError` are `VersionControlDomainError`, `VersionControlValidationError` and `NotImplementedVersionControlError`.
- Field and option names follow: the composition root's `workflowService`, `workflowHooks` and `reviewWorkflowService` are `versionControlService`, `versionControlHooks` and `changeRequestReviewService`, the tool context's `workflowService` is `versionControlService`, and a dependency named `workflow` (the locking filesystem's lock context, the pending-commits worker's driver, the module services that take the service) is `versionControl`.

Unchanged: every REST path (`/workflow/change-requests...` and `/workspace/:id/workflow/...` keep their prefix until a core major), MCP tool names, SSE event kinds, the agent guide, the database schema, log module names and the fallback committer identity.
