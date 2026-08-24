import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommunicationProtocol } from '@utcp/sdk';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { ToolManualService, normalizeToolManual } from '../tool-manuals.service.js';
import { canExecuteCliTemplates, containsCliCallTemplate } from '../utcp-cli-parse-only.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

/** A shell `.tool` in the shape the KB's `git.tool` uses: fenced YAML, cli templates. */
const gitTool = (extra = ''): string => `---
name: git
type: inline
description: Git over the local checkout.
${extra}tools:
  - name: status
    description: Porcelain status of a checkout.
    inputs:
      type: object
      properties:
        cwd: { type: string }
      required: [cwd]
    outputs:
      type: object
      properties: {}
    tool_call_template:
      call_template_type: cli
      commands:
        - command: git -C "UTCP_ARG_cwd_UTCP_END" status --porcelain
          append_to_final_output: true
---

Notes after the fence are ignored by the parser.
`;

describe('cli `.tool` manuals — parsed and listed, never executed', () => {
  test('the hosted process registers no cli executor', () => {
    // The serializer must be present (files parse) and the protocol absent
    // (nothing can dispatch). Asserted directly on the SDK registry, because
    // this is the backstop under the `remote: false` forcing below.
    expect(canExecuteCliTemplates()).toBe(false);
    expect(CommunicationProtocol.communicationProtocols.cli).toBeUndefined();
    expect(CommunicationProtocol.communicationProtocols.http).toBeDefined();
  });

  test('a cli call template is found wherever it is nested', () => {
    expect(containsCliCallTemplate(JSON.parse(JSON.stringify({ a: [{ b: { call_template_type: 'cli' } }] })))).toBe(true);
    expect(containsCliCallTemplate({ call_template_type: 'http' })).toBe(false);
    expect(containsCliCallTemplate({ call_template_type: ' CLI ' })).toBe(true);
    expect(containsCliCallTemplate(null)).toBe(false);
  });

  test('a shell `.tool` is forced local even without declaring it', () => {
    const d = normalizeToolManual('git', 'Plugins/git.tool', gitTool());
    expect(d.remote).toBe(false);
    expect(d.type).toBe('inline');
  });

  test('`remote: false` beside a cli template is accepted as written', () => {
    expect(normalizeToolManual('git', 'Plugins/git.tool', gitTool('remote: false\n')).remote).toBe(false);
  });

  test('`remote: true` beside a cli template is refused, not corrected', () => {
    expect(() => normalizeToolManual('git', 'Plugins/git.tool', gitTool('remote: true\n'))).toThrow(/cli.*call template|call template/i);
  });
});

describe('a shell `.tool` in a workspace', () => {
  let root: string;

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
  } as unknown as WorkspaceService;

  const allowAll = {
    canRead: async () => true,
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'clitools-'));
    const dir = join(root, wsId, KB_DIR, 'Plugins');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'git.tool'), gitTool());
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test('is listed to local consumers and withheld from remote ones', async () => {
    const svc = new ToolManualService(workspaceService, allowAll, KB_DIR);
    // `list_local_tools` names it, so the local server knows to materialize it.
    expect(await svc.listLocalOnly('user@x.eu')).toEqual([{ slug: 'git', name: 'git', path: 'Plugins/git.tool' }]);
    // The hosted proxy's manual set excludes it entirely.
    expect((await svc.toManualCallTemplates('user@x.eu', { remoteOnly: true })).map((t) => t.name)).toEqual([]);
    expect((await svc.toManualCallTemplates('user@x.eu')).map((t) => t.name)).toEqual(['git']);
  });

  test('its embedded cli tools survive manual serialization', async () => {
    // The whole point of registering the serializer: without it the manual body
    // fails validation and the local server gets nothing to run.
    const svc = new ToolManualService(workspaceService, allowAll, KB_DIR);
    const manual = await svc.resolveInlineManual('user@x.eu', 'git');
    expect(manual).not.toBeNull();
    const tools = (manual as { tools: { name: string; tool_call_template: { call_template_type: string } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(['status']);
    expect(tools[0].tool_call_template.call_template_type).toBe('cli');
  });
});
