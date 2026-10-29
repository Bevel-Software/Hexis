import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type express from 'express';
import { describe, expect, it } from 'vitest';
import type { IVersionControlService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { createEventsRoutes, VersionControlEventBus, type IEventDelivery } from '../index.js';
import { createVersionControlRoutes } from '../version-control.routes.js';

/**
 * The module's name is internal; what it mounts is not. The frontend, the
 * enterprise and customer scripts call these paths, and every open tab
 * switches on these event kinds, so a rename of the module must move none of
 * them. The `/workflow/` prefix stays until a core major.
 */

type Layer = { route?: { path: string; methods: Record<string, boolean> } };

function routesOf(router: express.Router): string[] {
  return (router.stack as Layer[]).flatMap((layer) =>
    layer.route ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`) : [],
  );
}

const VERSION_CONTROL_ROUTES = [
  'GET /workspace/:id/workflow/branches',
  'POST /workspace/:id/workflow/branches',
  'DELETE /workspace/:id/workflow/branches/:name',
  'GET /workspace/:id/workflow/branch-status',
  'POST /workspace/:id/workflow/share',
  'POST /workspace/:id/workflow/refresh-remotes',
  'POST /workspace/:id/workflow/update-from-remote',
  'GET /workspace/:id/workflow/fork-base',
  'GET /workspace/:id/workflow/pending-changes',
  'POST /workspace/:id/workflow/changes',
  'GET /workspace/:id/workflow/changes',
  'GET /workspace/:id/workflow/compare-file',
  'GET /workspace/:id/workflow/show-file',
  'GET /workspace/:id/workflow/file-at-change',
  'POST /workspace/:id/workflow/locks',
  'DELETE /workspace/:id/workflow/locks',
  'POST /workspace/:id/workflow/locks/checkpoint',
  'POST /workspace/:id/workflow/locks/heartbeat',
  'GET /workspace/:id/workflow/locks',
  'GET /workflow/change-requests',
  'GET /workflow/change-requests/mine',
  'GET /workflow/change-requests/for-me',
  'GET /workflow/change-requests/under-folder',
  'POST /workflow/change-requests/under-folder/remove',
  'GET /workflow/change-requests/:number',
  'GET /workflow/change-requests/:number/detail',
  'DELETE /workflow/change-requests/:number',
  'PATCH /workflow/change-requests/:number',
  'POST /workflow/change-requests/:number/files/revert',
  'POST /workflow/change-requests',
  'POST /workflow/change-requests/:number/update-from-target',
  'GET /workflow/change-requests/:number/fork-point-file',
  'POST /workflow/change-requests/:number/files/approve',
  'DELETE /workflow/change-requests/:number/files/approve',
  'POST /workflow/change-requests/:number/reject',
  'POST /workflow/change-requests/:number/merge',
];

const EVENT_KINDS = [
  'agent-connected',
  'agent-tool-call',
  'approval-changed',
  'branch-switched',
  'change-request-apply-failed',
  'change-request-edited',
  'change-request-merge-failed',
  'change-request-merged',
  'change-request-opened',
  'change-request-rejected',
  'document-unreadable',
  'file-changed',
  'fs-tree-changed',
  'git-sync-failed',
  'git-sync-recovered',
  'heartbeat',
  'lock-acquired',
  'lock-released',
  'resync',
];

describe('version-control public surface', () => {
  it('mounts every REST route at the path it had before the module was renamed', () => {
    const router = createVersionControlRoutes(
      {} as IVersionControlService,
      {} as WorkspaceService,
      {} as AuthService,
      new VersionControlEventBus(),
      {} as IAccessControl,
      'knowledge-base',
    );
    expect(routesOf(router)).toEqual(VERSION_CONTROL_ROUTES);
  });

  it('mounts the live-event stream at /events', () => {
    const router = createEventsRoutes(new VersionControlEventBus(), (_req, _res, next) => next(), {} as IEventDelivery);
    expect(routesOf(router)).toEqual(['GET /events', 'POST /events/:sessionId/focus']);
  });

  it('keeps every SSE event kind the shared contract declares', () => {
    // The kinds are a type-only union, and the backend's typecheck skips
    // tests, so the pin reads the contract's source rather than a type.
    const shared = dirname(createRequire(import.meta.url).resolve('@bevel-software/platform-shared/package.json'));
    const source = readFileSync(join(shared, 'src', 'version-control', 'events.ts'), 'utf-8');
    const kinds = [...source.matchAll(/^\s+kind: '([a-z-]+)';$/gm)].map((m) => m[1]).sort();
    expect(kinds).toEqual(EVENT_KINDS);
  });
});
