import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { GUIDE_FIRST_SENTENCE } from '../../tool-registry/guide-first.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { SpillStore } from '../spill-store.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { ToolDescriptionNotes } from '../../workspace/agent-access.gate.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { sharedFileRulesSection } from '../../agent-instructions/shared-file-rules.js';

/**
 * What the platform TELLS AN AGENT about the guide.
 *
 * The conventions reminder and the platform-file list are SHARED RULES —
 * stated in the handshake instructions and in the guide, once each — so their
 * wording is asserted against that one text. What each tool description has
 * to get right is its OPENING: the one sentence saying to call
 * `get_agent_guide` first, which the catalog puts at the front of every tool
 * (see tool-registry/guide-first.ts); a remote agent has no checkout, so that
 * sentence and the rule are the only places it learns what to read first.
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

describe('what tells an agent to read the guide first', () => {
  it('tells an agent to call get_agent_guide first, and that AGENTS.md answers with the same guide after the organisation\'s own', () => {
    const rules = sharedFileRulesSection(kb.layout);
    expect(rules).toContain("call `get_agent_guide` and read the platform's guide");
    expect(rules).toContain('read_file on `AGENTS.md` at the KB root answers with the same guide');
    expect(rules).toContain("after the organisation's own conventions file of that name");
    expect(rules).toContain('`CLAUDE.md`');
    // One name on every deployment: the rule names no other.
    expect(rules).not.toContain('HEXIS.md');
  });

  it('opens every entrypoint with the guide-first sentence, reads included', async () => {
    const byName = await descriptions();
    for (const name of ['grep', 'list_files', 'file_stat', 'read_file', 'write_file', 'move_file', 'start_session']) {
      expect(byName.get(name)!.startsWith(`${GUIDE_FIRST_SENTENCE} `), name).toBe(true);
      // Once, at the front — never again further down.
      expect(byName.get(name)!.split(GUIDE_FIRST_SENTENCE), name).toHaveLength(2);
    }
  });

  it('lists the guide under no name as a platform file, and ignores a name a deployment saved for it', () => {
    kb.applyLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    const rules = sharedFileRulesSection(kb.layout);
    expect(rules).toContain('`access.md` or `.bevelignore` in any folder, `roles.yaml` at the repository root');
    expect(rules).not.toContain('HEXIS.md');
    expect(rules).toBe(sharedFileRulesSection(DEFAULT_KB_LAYOUT));
  });

  /**
   * First-run setup on a fresh deployment: the tools are mounted at boot, under
   * the defaults, and the save that COMPLETES setup applies the admin's names
   * in that same request — without a restart. Nothing in the opening sentence
   * moves with a name, so what the catalog said at boot is what it says after.
   */
  it('says the same thing after a layout is applied as it did at the mount', async () => {
    const registry = new ToolRegistry();
    const atMount = await descriptions(registry);
    kb.applyLayout({ ...DEFAULT_KB_LAYOUT, knowledgeBaseDir: 'Docs' });
    const now = await listed(registry);
    for (const name of ['grep', 'file_stat', 'delete_file', 'move_file']) {
      expect(now.get(name)!.startsWith(GUIDE_FIRST_SENTENCE), name).toBe(true);
      expect(now.get(name), name).toBe(atMount.get(name));
    }
  });
});
