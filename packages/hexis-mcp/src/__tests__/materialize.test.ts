import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  expandPlaceholders,
  prepareStdioSpec,
  readBodyCapped,
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

describe('readBodyCapped', () => {
  const stream = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });

  it('buffers a body under the cap byte-for-byte', async () => {
    expect((await readBodyCapped(stream('ab', 'cd'), 10, 'the archive')).toString()).toBe('abcd');
  });

  it('refuses AS the cap is crossed — the oversized body is never held in memory', async () => {
    // A pull-based endless stream: the pull count proves the refusal happened
    // at the cap, not after the producer finished.
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4));
      },
    });
    await expect(readBodyCapped(endless, 10, 'the archive')).rejects.toThrow(/download limit/);
    expect(pulls).toBeLessThan(10);
  });

  it('treats a missing body as empty', async () => {
    expect((await readBodyCapped(null, 10, 'the archive')).length).toBe(0);
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
