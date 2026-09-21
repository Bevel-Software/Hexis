import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_KB_LAYOUT, configureKbLayout } from '@bevel-software/platform-shared';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { SpillStore } from '../spill-store.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { registerWorkspaceTools } from '../workspace.tools.js';

/**
 * What the platform TELLS AN AGENT about the conventions file, under the
 * default name and under a deployment's own.
 *
 * Descriptions only: the behaviour behind them is covered in
 * `workspace.tools.test.ts`, and what matters here is the text a remote agent
 * reads, which is the only place it learns that the organisation's own
 * `AGENTS.md` exists at all — it has no checkout, so no harness reads that file
 * for it.
 */
const KB_DIR = 'knowledge-base';

/** Every workspace tool's description, keyed by name, under the layout in effect. */
async function descriptions(registry: ToolRegistry = new ToolRegistry()): Promise<Map<string, string>> {
  const router = express.Router();
  const auth = ((_req: unknown, _res: unknown, next: () => void) => next()) as unknown as ToolAuth;
  registerWorkspaceTools(
    registry,
    router,
    auth,
    createToolHandlerFactory(() => ({ userEmail: 'a@x.io' })) as never,
    new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    new DocExtractService(join(tmpdir(), 'bevel-test-doc-extract')),
    {} as unknown as IAccessControl,
    KB_DIR,
    {
      service: {} as never,
      enabled: false,
      kbDirName: KB_DIR,
      recoveryBotEmail: 'recovery-bot@bevel.local',
      hooks: new WorkflowHooks(),
    },
    new RoutineWritePolicyService(),
    {} as never,
  );
  return listed(registry);
}

/** What the catalog says NOW, with nothing registered again. */
async function listed(registry: ToolRegistry): Promise<Map<string, string>> {
  const tools = await registry.listExternal();
  return new Map(tools.map((t) => [t.name, t.description ?? '']));
}

afterEach(() => configureKbLayout({ ...DEFAULT_KB_LAYOUT }));

describe('the conventions note every workspace tool carries', () => {
  it('names AGENTS.md, and CLAUDE.md beside it, under the default name', async () => {
    const byName = await descriptions();
    // On EVERY entrypoint, reads included: any of them can be a session's first.
    for (const name of ['grep', 'list_files', 'file_stat', 'write_file', 'move_file']) {
      expect(byName.get(name), name).toContain(
        'read `AGENTS.md` at the KB root — or `CLAUDE.md` on a knowledge base seeded before it was renamed',
      );
    }
  });

  it('names the configured file first and the organisation\'s own AGENTS.md second', async () => {
    configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    const byName = await descriptions();
    const note = byName.get('grep') ?? '';
    expect(note).toContain('read `HEXIS.md` at the KB root, then `AGENTS.md` if it also exists');
    expect(note).toContain("the organisation's own conventions");
    // Ours first: an agent that reads only one must read the platform's.
    expect(note.indexOf('`HEXIS.md`')).toBeLessThan(note.indexOf('`AGENTS.md`'));
    // The legacy name is still offered, for a KB seeded before the rename.
    expect(note).toContain('`CLAUDE.md`');
  });

  it('describes the platform files under the configured name, and no longer under AGENTS.md', async () => {
    configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    const byName = await descriptions();
    const stat = byName.get('file_stat') ?? '';
    expect(stat).toContain('`access.md`, `roles.yaml`, `.bevelignore`, `HEXIS.md`');

    for (const name of ['delete_file', 'move_file']) {
      const text = byName.get(name) ?? '';
      expect(text, name).toContain('`roles.yaml` or `HEXIS.md` at the repository root');
      // The customer's file is content on such a deployment, so the rule that
      // refuses a move must not claim it.
      expect(text.replace(/`AGENTS\.md` if it also exists/g, ''), name).not.toContain(
        'or `AGENTS.md` at the repository root',
      );
    }
  });

  it('keeps naming AGENTS.md as a platform file under the default name', async () => {
    const byName = await descriptions();
    expect(byName.get('file_stat')).toContain('`access.md`, `roles.yaml`, `.bevelignore`, `AGENTS.md`');
    expect(byName.get('delete_file')).toContain('`roles.yaml` or `AGENTS.md` at the repository root');
  });

  /**
   * First-run setup on a fresh deployment: the tools are mounted at boot, under
   * the defaults, and the save that COMPLETES setup applies the admin's names
   * in that same request — without a restart, deliberately, so the KB phase it
   * runs next scaffolds the names they chose. A catalog built once at boot
   * would go on naming `AGENTS.md` to every agent that connected afterwards.
   */
  it('follows a layout applied after the tools were mounted', async () => {
    const registry = new ToolRegistry();
    const atMount = await descriptions(registry);
    expect(atMount.get('grep')).toContain('read `AGENTS.md` at the KB root');

    configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });

    const now = await listed(registry);
    expect(now.get('grep')).toContain('read `HEXIS.md` at the KB root, then `AGENTS.md` if it also exists');
    expect(now.get('file_stat')).toContain('`access.md`, `roles.yaml`, `.bevelignore`, `HEXIS.md`');
    expect(now.get('delete_file')).toContain('`roles.yaml` or `HEXIS.md` at the repository root');
    expect(now.get('move_file')).toContain('`roles.yaml` or `HEXIS.md` at the repository root');
  });
});
