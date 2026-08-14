import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  expandPlaceholders,
  prepareStdioSpec,
  resolveCommand,
  type MaterializedPlugin,
} from '../materialize.js';

let root: string;
let m: MaterializedPlugin;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-mat-'));
  m = { pluginRoot: path.join(root, 'plugin'), pluginData: path.join(root, 'data') };
  await fs.mkdir(path.join(m.pluginRoot, 'bin'), { recursive: true });
  await fs.mkdir(m.pluginData, { recursive: true });
  await fs.writeFile(path.join(m.pluginRoot, 'bin', 'server.js'), '// server\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('expandPlaceholders', () => {
  it('is a single, non-recursive replacement; unknown placeholders stay literal', () => {
    expect(expandPlaceholders('${PLUGIN_ROOT}/rules.yaml', m)).toBe(`${m.pluginRoot}/rules.yaml`);
    expect(expandPlaceholders('${PLUGIN_DATA}/cache', m)).toBe(`${m.pluginData}/cache`);
    // The spec: "Unrecognized placeholder-like text MUST remain literal."
    expect(expandPlaceholders('${VENDOR_KEY}', m)).toBe('${VENDOR_KEY}');
  });
});

describe('resolveCommand', () => {
  it('passes a bare name through to PATH lookup', async () => {
    expect(await resolveCommand('npx', m)).toBe('npx');
  });

  it('resolves ./ against the plugin root when the target exists', async () => {
    expect(await resolveCommand('./bin/server.js', m)).toBe(
      path.resolve(m.pluginRoot, './bin/server.js'),
    );
  });

  it('refuses escapes, absolute paths, and missing targets', async () => {
    await expect(resolveCommand('./../../etc/passwd', m)).rejects.toThrow(/escapes the plugin root/);
    await expect(resolveCommand('/usr/bin/env', m)).rejects.toThrow(/bare executable name/);
    await expect(resolveCommand('./bin/missing', m)).rejects.toThrow(/does not exist/);
  });
});

describe('prepareStdioSpec', () => {
  it('expands args/env/cwd, adds the two runtime variables, defaults cwd to the root', async () => {
    const prepared = await prepareStdioSpec(
      {
        command: './bin/server.js',
        args: ['--rules', '${PLUGIN_ROOT}/rules.yaml'],
        env: { CACHE: '${PLUGIN_DATA}/cache' },
      },
      m,
    );
    expect(prepared.args).toEqual(['--rules', `${m.pluginRoot}/rules.yaml`]);
    expect(prepared.env).toEqual({
      CACHE: `${m.pluginData}/cache`,
      PLUGIN_ROOT: m.pluginRoot,
      PLUGIN_DATA: m.pluginData,
    });
    expect(prepared.cwd).toBe(m.pluginRoot);
  });

  it('refuses a server env that shadows the runtime variables', async () => {
    await expect(
      prepareStdioSpec({ command: 'npx', env: { PLUGIN_ROOT: '/lie' } }, m),
    ).rejects.toThrow(/must not declare PLUGIN_ROOT/);
  });
});
