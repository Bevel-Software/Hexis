import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { SpillStore } from '../spill-store.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { ToolDescriptionNotes } from '../../workspace/agent-access.gate.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { sharedFileRulesSection, sharedRulesPointer } from '../../agent-instructions/shared-file-rules.js';

/**
 * What the platform TELLS AN AGENT about the guide.
 *
 * The conventions reminder and the platform-file list are SHARED RULES —
 * stated in the handshake instructions and in the guide, once each — so their
 * wording is asserted against that one text. What each tool description still
 * has to get right is the POINTER at the end, which names the section and the
 * tool that returns the guide; a remote agent has no checkout, so that
 * pointer and the rule are the only places it learns what to read first.
 */
const KB_DIR = 'knowledge-base';
/** The context the tools read; a case applies a deployment's own names to it. */
const kb = testKbContext({ kbDirName: KB_DIR });

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
    kb,
    {
      recoveryBotEmail: 'recovery-bot@bevel.local',
      hooks: new WorkflowHooks(),
      notes: new ToolDescriptionNotes(),
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

afterEach(() => kb.applyLayout({ ...DEFAULT_KB_LAYOUT }));

describe('what names the guide, under the default name and under a name a deployment saved', () => {
  it('tells an agent to read AGENTS.md first, and that the organisation\'s own file comes with it', () => {
    const rules = sharedFileRulesSection(kb.layout);
    expect(rules).toContain('read `AGENTS.md` at the KB root: it answers with the platform\'s guide');
    expect(rules).toContain("after the organisation's own conventions file of that name");
    expect(rules).toContain('`CLAUDE.md`');
  });

  it('points every entrypoint at the section, by the tool that returns the guide', async () => {
    const byName = await descriptions();
    // On EVERY entrypoint, reads included: any of them can be a session's first.
    for (const name of ['grep', 'list_files', 'file_stat', 'read_file', 'write_file', 'move_file']) {
      expect(byName.get(name), name).toContain('see "Working with files" in the agent guide (get_agent_guide).');
    }
  });

  it('names a saved alias beside AGENTS.md, and lists the guide under neither as a platform file', () => {
    kb.applyLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    const rules = sharedFileRulesSection(kb.layout);
    expect(rules).toContain('read `AGENTS.md` at the KB root (or `HEXIS.md` here)');
    // The guide is not on disk under any name, so a move never refuses one.
    expect(rules).toContain('`access.md` or `.bevelignore` in any folder, `roles.yaml` at the repository root');
    expect(rules).not.toContain('`HEXIS.md` at the repository root');
    expect(rules).not.toContain('`AGENTS.md` at the repository root');
  });

  /**
   * First-run setup on a fresh deployment: the tools are mounted at boot, under
   * the defaults, and the save that COMPLETES setup applies the admin's names
   * in that same request — without a restart. The pointer no longer moves with
   * a name, so what the catalog said at boot is what it says after.
   */
  it('says the same thing after a layout is applied as it did at the mount', async () => {
    const registry = new ToolRegistry();
    const atMount = await descriptions(registry);
    kb.applyLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    const now = await listed(registry);
    for (const name of ['grep', 'file_stat', 'delete_file', 'move_file']) {
      expect(now.get(name), name).toContain(sharedRulesPointer(kb.layout));
      expect(now.get(name), name).toBe(atMount.get(name));
    }
  });
});
