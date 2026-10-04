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
 * What the platform TELLS AN AGENT about the conventions file, under the
 * default name and under a deployment's own.
 *
 * The conventions reminder and the platform-file list are SHARED RULES now —
 * stated in the handshake instructions and in the managed agent guide, once
 * each — so their wording is asserted against that one text. What each tool
 * description still has to get right is the POINTER at the end, which names the
 * guide by the name this deployment gave it; that is the only place a remote
 * agent learns which file to open, and it has no checkout, so no harness reads
 * that file for it.
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

describe("what names the guide, under the default name and under a deployment's own", () => {
  it('names AGENTS.md, and CLAUDE.md beside it, under the default name', () => {
    const rules = sharedFileRulesSection(kb.layout);
    expect(rules).toContain(
      'read `AGENTS.md` at the KB root — or `CLAUDE.md` on a knowledge base seeded before it was renamed',
    );
  });

  it("points every entrypoint at the section, by the guide's own name", async () => {
    const byName = await descriptions();
    // On EVERY entrypoint, reads included: any of them can be a session's first.
    for (const name of ['grep', 'list_files', 'file_stat', 'write_file', 'move_file']) {
      expect(byName.get(name), name).toContain('see "Working with files" in AGENTS.md.');
    }
  });

  it("names the configured file first and the organisation's own AGENTS.md second", () => {
    kb.applyLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    const note = sharedFileRulesSection(kb.layout);
    expect(note).toContain('read `HEXIS.md` at the KB root, then `AGENTS.md` if it also exists');
    expect(note).toContain("the organisation's own conventions");
    // Ours first: an agent that reads only one must read the platform's.
    expect(note.indexOf('`HEXIS.md`')).toBeLessThan(note.indexOf('`AGENTS.md`'));
    // The legacy name is still offered, for a KB seeded before the rename.
    expect(note).toContain('`CLAUDE.md`');
  });

  it('lists the platform files under the configured name, and no longer under AGENTS.md', () => {
    kb.applyLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    const rules = sharedFileRulesSection(kb.layout);
    // Listed with the depth each one counts at — `access.md` and
    // `.bevelignore` govern the folder they sit in, the other two are read from
    // the root — because the names alone would have an agent refuse a nested
    // `HEXIS.md` it may rename.
    expect(rules).toContain('`access.md` or `.bevelignore` in any folder, `roles.yaml` or `HEXIS.md` at the repository root');
    // The customer's file is content on such a deployment, so the rule that
    // refuses a move must not claim it.
    expect(rules.replace(/`AGENTS\.md` if it also exists/g, '')).not.toContain('`AGENTS.md`');
  });

  it('keeps naming AGENTS.md as a platform file under the default name', () => {
    expect(sharedFileRulesSection(kb.layout)).toContain(
      '`access.md` or `.bevelignore` in any folder, `roles.yaml` or `AGENTS.md` at the repository root',
    );
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
    expect(atMount.get('grep')).toContain('in AGENTS.md.');

    kb.applyLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });

    const now = await listed(registry);
    for (const name of ['grep', 'file_stat', 'delete_file', 'move_file']) {
      expect(now.get(name), name).toContain(sharedRulesPointer(kb.layout));
      expect(now.get(name), name).not.toContain('in AGENTS.md.');
    }
  });
});
