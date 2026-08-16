import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@utcp/sdk';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { findToolByName, findToolsByNames, utcpNameToTsInterfaceName } from '../code-mode-names.js';

function utcpTool(name: string): Tool {
  return {
    name,
    description: `the ${name} tool`,
    inputs: { type: 'object', properties: {} },
    outputs: { type: 'object', properties: {} },
    tags: [],
    tool_call_template: { call_template_type: 'http' } as never,
  } as Tool;
}

function clientWith(tools: Tool[]) {
  const getTools = vi.fn(async () => tools);
  const getTool = vi.fn(async (name: string) => tools.find((t) => t.name === name) ?? null);
  const client = {
    config: { tool_repository: { getTool, getTools } },
  } as unknown as CodeModeUtcpClient;
  return { client, getTools, getTool };
}

describe('utcpNameToTsInterfaceName', () => {
  it('sanitizes both halves of a namespaced name', () => {
    expect(utcpNameToTsInterfaceName('MY-MANUAL.read-file')).toBe('MY_MANUAL.read_file');
  });
});

describe('findToolByName', () => {
  it('resolves an exact UTCP name without touching the full catalog', async () => {
    const { client, getTools } = clientWith([utcpTool('m.read-file')]);
    const found = await findToolByName(client, 'm.read-file');
    expect(found?.utcpName).toBe('m.read-file');
    expect(getTools).not.toHaveBeenCalled();
  });

  it('resolves a sanitized TS-accessible name back to its UTCP tool', async () => {
    const { client } = clientWith([utcpTool('m.read-file')]);
    const found = await findToolByName(client, 'm.read_file');
    expect(found?.utcpName).toBe('m.read-file');
  });

  it('returns null for an unknown name', async () => {
    const { client } = clientWith([utcpTool('m.read-file')]);
    expect(await findToolByName(client, 'm.nope')).toBeNull();
  });

  it('refuses an ambiguous sanitized name, naming every collider', async () => {
    // Sanitization is lossy: `-` and an extra `.` both land on `_`.
    const { client } = clientWith([utcpTool('m.read-file'), utcpTool('m.read.file')]);
    await expect(findToolByName(client, 'm.read_file')).rejects.toThrow(
      /ambiguous.*"m\.read-file".*"m\.read\.file"/,
    );
  });

  it('an exact UTCP name still wins even when its sanitized form collides', async () => {
    const { client } = clientWith([utcpTool('m.read-file'), utcpTool('m.read.file')]);
    const found = await findToolByName(client, 'm.read-file');
    expect(found?.utcpName).toBe('m.read-file');
  });
});

describe('findToolsByNames', () => {
  it('fetches the catalog once for a whole batch of sanitized names', async () => {
    const { client, getTools } = clientWith([utcpTool('m.read-file'), utcpTool('m.write-file')]);
    const resolved = await findToolsByNames(client, ['m.read_file', 'm.write_file', 'm.missing']);
    expect(resolved.get('m.read_file')?.utcpName).toBe('m.read-file');
    expect(resolved.get('m.write_file')?.utcpName).toBe('m.write-file');
    expect(resolved.has('m.missing')).toBe(false);
    expect(getTools).toHaveBeenCalledTimes(1);
  });

  it('skips the catalog fetch entirely when every name is exact', async () => {
    const { client, getTools } = clientWith([utcpTool('m.read-file')]);
    const resolved = await findToolsByNames(client, ['m.read-file']);
    expect(resolved.size).toBe(1);
    expect(getTools).not.toHaveBeenCalled();
  });
});
