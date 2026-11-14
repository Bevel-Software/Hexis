import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createCoreServices } from '../../index.js';
import type { TenantConfig } from '../../core-config.js';

/**
 * The server's boot, through the package's own entry, on a PATH that carries
 * git and no ripgrep: it refuses to build any service, naming the binary.
 */
describe('booting without ripgrep', () => {
  const path = process.env.PATH;
  let bin = '';
  afterEach(async () => {
    process.env.PATH = path;
    if (bin) await rm(bin, { recursive: true, force: true });
    bin = '';
  });

  it('refuses to start, naming rg and the Dockerfile that installs it', async () => {
    const git = (await promisify(execFile)('sh', ['-c', 'command -v git'])).stdout.trim();
    bin = await mkdtemp(join(tmpdir(), 'no-rg-'));
    await symlink(git, join(bin, 'git'));
    process.env.PATH = bin;
    // The binaries are checked before the configuration is read, so none is needed.
    const err = (await createCoreServices({} as TenantConfig).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^ripgrep \(`rg`\) is required on the server's PATH but could not be run: .*ENOENT/);
    expect(err.message).toContain('The Hexis Dockerfile installs it');
  });
});
