import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import {
  AgentDefinitionService,
  normalizeAgentDefinition,
  agentVaultKey,
  parseAgentVaultKey,
} from '../agent-defs.service.js';
import { utcpNamespacedKey } from '../../../shared/utcp-namespace.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

const CODER = `---
apiVersion: bevel.software/v1
kind: Agent
owner: [Razvan <razvan@example.com>]
read: [coding-agent <coding-agent@example.com>]

name: delivery-coder
description: Implements a ticket in a prepared workspace.
harness: claude-code
model: claude-opus-5
skills:
  - Plugins/Engineering/coding/delivery-coding
env:
  - { name: TENANT_ID, from: params }
  - { name: DATABASE_URL, from: params }
  - { name: OPENAI_API_KEY, from: vault, label: Model access for the app under test }
---

Free-form notes after the fence.
`;

describe('normalizeAgentDefinition', () => {
  test('reads identity and the vault half of `env:`, ignoring everything else', () => {
    const a = normalizeAgentDefinition('delivery-coder', 'Agents/delivery-coder.agent', CODER);
    expect(a.slug).toBe('delivery_coder');
    expect(a.name).toBe('delivery-coder');
    expect(a.description).toBe('Implements a ticket in a prepared workspace.');
    // `from: params` entries are the pipeline's business — the platform never
    // sees a parameter value, so they must not appear in the allowlist.
    expect(a.vaultVariables).toEqual([
      { name: 'OPENAI_API_KEY', from: 'vault', label: 'Model access for the app under test' },
    ]);
  });

  test('an agent declaring no env has an empty allowlist', () => {
    expect(normalizeAgentDefinition('x', 'Agents/x.agent', 'name: x\n').vaultVariables).toEqual([]);
  });

  test('reads a fence-less file as the object itself', () => {
    const a = normalizeAgentDefinition('x', 'Agents/x.agent', 'name: mechanic\nenv:\n  - { name: TOKEN, from: vault }\n');
    expect(a.slug).toBe('mechanic');
    expect(a.vaultVariables.map((v) => v.name)).toEqual(['TOKEN']);
  });

  test('an explicit id must be snake_case, and wins over the name', () => {
    expect(normalizeAgentDefinition('x', 'Agents/x.agent', 'id: my_agent\nname: Something Else\n').slug).toBe('my_agent');
    expect(() => normalizeAgentDefinition('x', 'Agents/x.agent', 'id: My-Agent\n')).toThrow(/snake_case/);
  });

  test.each([
    ['env is not an array', 'name: x\nenv: nope\n', /`env` must be an array/],
    ['an entry is not an object', 'name: x\nenv: [TOKEN]\n', /must be an object/],
    ['a name is not a POSIX env name', 'name: x\nenv:\n  - { name: "a-b", from: vault }\n', /must match/],
    ['from is missing', 'name: x\nenv:\n  - { name: TOKEN }\n', /from: params.*from: vault/],
    ['from is unknown', 'name: x\nenv:\n  - { name: TOKEN, from: elsewhere }\n', /from: params.*from: vault/],
    ['a name repeats', 'name: x\nenv:\n  - { name: T, from: vault }\n  - { name: T, from: params }\n', /duplicate/],
    ['the file is not an object', '- a\n- b\n', /must be a YAML object/],
  ])('refuses the whole file when %s', (_why, content, message) => {
    // A malformed entry throws rather than being dropped: an allowlist that
    // silently loses an entry it could not read is unreviewable.
    expect(() => normalizeAgentDefinition('x', 'Agents/x.agent', content)).toThrow(message);
  });
});

describe('agent vault keys', () => {
  test('are namespaced per agent, and round-trip', () => {
    const key = agentVaultKey('delivery_coder', 'OPENAI_API_KEY');
    expect(key).toBe('agent:delivery_coder:OPENAI_API_KEY');
    expect(parseAgentVaultKey(key)).toEqual({ slug: 'delivery_coder', name: 'OPENAI_API_KEY' });
  });

  test('can never collide with a tool variable key, whatever the tool is called', () => {
    // Tool namespaces are built by mapping every non-word character to `_`, so
    // no manual name can produce a `:`. That is what keeps the two namespaces
    // disjoint in one flat keyspace — assert it rather than trusting it.
    for (const manual of ['agent', 'agent:delivery_coder', 'delivery_coder', 'agent_delivery_coder']) {
      expect(utcpNamespacedKey(manual, 'OPENAI_API_KEY')).not.toContain(':');
      expect(utcpNamespacedKey(manual, 'OPENAI_API_KEY')).not.toBe(agentVaultKey('delivery_coder', 'OPENAI_API_KEY'));
    }
  });

  test('rejects anything that is not an agent key', () => {
    expect(parseAgentVaultKey('weather_WEATHER_KEY')).toBeNull();
    expect(parseAgentVaultKey('agent:only_two')).toBeNull();
    expect(parseAgentVaultKey('agent::VAR')).toBeNull();
  });
});

describe('AgentDefinitionService', () => {
  let root: string;

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
  } as unknown as WorkspaceService;

  const access = (denied: string[] = []): IAccessControl =>
    ({
      canRead: async (_w: string, _e: string, p: string) => !denied.some((d) => p.includes(d)),
      canReadBatch: async (_w: string, _e: string, paths: string[]) =>
        new Map(paths.map((p) => [p, !denied.some((d) => p.includes(d))])),
    }) as unknown as IAccessControl;

  const agentsDir = () => join(root, wsId, KB_DIR, 'Agents');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agents-'));
    await mkdir(agentsDir(), { recursive: true });
    await writeFile(join(agentsDir(), 'delivery-coder.agent'), CODER);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test('scans `.agent` files from the default branch', async () => {
    const svc = new AgentDefinitionService(workspaceService, access(), KB_DIR);
    const list = await svc.listAccessible('user@x.eu');
    expect(list.map((a) => a.path)).toEqual(['Agents/delivery-coder.agent']);
    expect(list[0].vaultVariables.map((v) => v.name)).toEqual(['OPENAI_API_KEY']);
  });

  test('an unreadable `.agent` is absent, not empty', async () => {
    const svc = new AgentDefinitionService(workspaceService, access(['delivery-coder']), KB_DIR);
    expect(await svc.listAccessible('user@x.eu')).toEqual([]);
    expect(await svc.getAccessible('user@x.eu', 'delivery_coder')).toBeNull();
    // …but it still exists as far as the platform is concerned.
    expect((await svc.listAll()).map((a) => a.slug)).toEqual(['delivery_coder']);
  });

  test('a malformed `.agent` is skipped without taking the others with it', async () => {
    await writeFile(join(agentsDir(), 'broken.agent'), 'env: not-an-array\n');
    const svc = new AgentDefinitionService(workspaceService, access(), KB_DIR);
    expect((await svc.listAll()).map((a) => a.slug)).toEqual(['delivery_coder']);
  });

  test('a duplicate slug is refused rather than suffixed', async () => {
    // Auto-suffixing would silently rebind a provisioned secret to a new file.
    await mkdir(join(agentsDir(), 'nested'), { recursive: true });
    await writeFile(join(agentsDir(), 'nested', 'other.agent'), 'name: delivery-coder\n');
    const svc = new AgentDefinitionService(workspaceService, access(), KB_DIR);
    const all = await svc.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].path).toBe('Agents/delivery-coder.agent');
  });

  test('no Agents/ folder is an empty list, not a failure', async () => {
    await rm(agentsDir(), { recursive: true, force: true });
    const svc = new AgentDefinitionService(workspaceService, access(), KB_DIR);
    expect(await svc.listAll()).toEqual([]);
  });
});
