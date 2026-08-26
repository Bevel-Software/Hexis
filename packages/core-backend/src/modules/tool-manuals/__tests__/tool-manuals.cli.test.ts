import { describe, test, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallTemplateSerializer, CommunicationProtocol, UtcpClient } from '@utcp/sdk';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { ToolManualService, normalizeToolManual } from '../tool-manuals.service.js';
import { canExecuteCliTemplates, containsCliCallTemplate } from '../utcp-cli-parse-only.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { utcpNamespacePrefix } from '../../../shared/utcp-namespace.js';
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
  test('the hosted process cannot DISPATCH a cli template', async () => {
    // The claim worth pinning is not "the map lacks a key" — it is that a cli
    // template actually fails to dispatch. A registry assertion alone would
    // still pass if some other module re-registered the protocol at runtime, or
    // if dispatch consulted a different map; this exercises the path a
    // dispatching caller takes.
    expect(canExecuteCliTemplates()).toBe(false);

    const template = new CallTemplateSerializer().validateDict({
      name: 'git',
      call_template_type: 'cli',
      commands: [{ command: 'git status', append_to_final_output: true }],
    });
    const protocol = CommunicationProtocol.communicationProtocols[template.call_template_type];
    expect(protocol).toBeUndefined();

    // And a client built in this process refuses it rather than shelling out.
    const client = await UtcpClient.create(process.cwd(), { variables: {} } as never);
    try {
      // The reason, not any reason: a shape or URL error would also reject,
      // and would leave the guarantee this test exists for unverified.
      await expect(client.registerManual(template)).rejects.toThrow(
        /No communication protocol registered for type: 'cli'/,
      );
    } finally {
      // Closing releases the client's communication protocols and their
      // transports; left open they outlive the test for the whole run.
      await client.close().catch(() => {});
    }
  });

  test('the serializer IS registered, or these files would not parse at all', () => {
    // The other half of the split: the platform must understand a cli template
    // well enough to validate and serve it, which is why the package is
    // imported at all.
    expect(() =>
      new CallTemplateSerializer().validateDict({
        name: 'git',
        call_template_type: 'cli',
        commands: [{ command: 'git status' }],
      }),
    ).not.toThrow();
    expect(CommunicationProtocol.communicationProtocols.http).toBeDefined();
  });

  test('a cyclic document is examined, not blown up on', () => {
    // A YAML self-alias really does produce a cyclic object. The backstop must
    // still find the cli template beside the cycle rather than overflow.
    const cyclic: Record<string, unknown> = { tools: [{ tool_call_template: { call_template_type: 'cli' } }] };
    cyclic.self = cyclic;
    expect(containsCliCallTemplate(cyclic)).toBe(true);
    const benign: Record<string, unknown> = { a: { call_template_type: 'http' } };
    benign.self = benign;
    expect(containsCliCallTemplate(benign)).toBe(false);
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

describe('manual namespaces are unique, not merely manual names', () => {
  let root: string;

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
  } as unknown as WorkspaceService;

  const allowAll = {
    canRead: async () => true,
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;

  const pluginsDir = () => join(root, wsId, KB_DIR, 'Plugins');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ns-'));
    await mkdir(pluginsDir(), { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  /** A `.tool` file. Its `id` grammar is `[a-z0-9_]` — it cannot carry a hyphen. */
  const writeTool = (file: string, id: string) =>
    writeFile(join(pluginsDir(), file), JSON.stringify({ id, type: 'inline', tools: [] }));

  /**
   * An mcp.json server. THIS is the only path a hyphen can enter a manual name:
   * its grammar allows `-`, so it is the only way to build a real collision.
   */
  async function writeMcpServer(folder: string, serverName: string): Promise<void> {
    await mkdir(join(pluginsDir(), folder), { recursive: true });
    await writeFile(
      join(pluginsDir(), folder, 'mcp.json'),
      JSON.stringify({ mcpServers: { [serverName]: { type: 'streamable-http', url: 'https://v.example/mcp' } } }),
    );
  }

  const names = async (): Promise<string[]> =>
    (await new ToolManualService(workspaceService, allowAll, KB_DIR).listAllSummaries()).map((m) => m.name).sort();

  it('keeps two manuals whose namespaces genuinely differ', async () => {
    // Underscore-doubling is injective, so `a_b` (a__b_) and `a__b` (a____b_)
    // are distinct namespaces and both must survive.
    await writeTool('a.tool', 'a_b');
    await writeTool('b.tool', 'a__b');
    expect(await names()).toEqual(['a__b', 'a_b']);
  });

  it('drops the second of two manuals sharing one namespace', async () => {
    // `a-b` and `a_b` are different NAMES with the same NAMESPACE `a__b_`, and
    // therefore one set of vault keys — either able to resolve the other's
    // secrets. Deduping by raw name let both through; this is the case that
    // proves the check compares namespaces.
    await writeMcpServer('Vendor', 'a-b');
    await writeTool('a.tool', 'a_b');
    const kept = await names();
    expect(kept).toHaveLength(1);
    // mcp.json descriptors are listed before `.tool` files, and the shared
    // dedupe keeps the first occurrence, so the server is the survivor.
    expect(kept).toEqual(['a-b']);
  });

  it('leaves both when the hyphenated name does NOT collide', async () => {
    // Guards the fix from being over-broad: hyphens stay usable, which matters
    // because MCP servers in the wild are routinely named with them.
    await writeMcpServer('Vendor', 'sequential-thinking');
    await writeTool('a.tool', 'a_b');
    expect(await names()).toEqual(['a_b', 'sequential-thinking']);
  });

  it('keeps every surviving namespace distinct', async () => {
    // The invariant secrets actually depend on, asserted directly.
    await writeMcpServer('Vendor', 'a-b');
    await writeTool('a.tool', 'a_b');
    await writeTool('c.tool', 'other');
    const kept = await new ToolManualService(workspaceService, allowAll, KB_DIR).listAllSummaries();
    const namespaces = kept.map((m) => utcpNamespacePrefix(m.name));
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });
});
