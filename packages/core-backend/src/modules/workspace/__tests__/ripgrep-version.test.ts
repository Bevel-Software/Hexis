import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertRipgrep } from '../index.js';

/** The boot check, against the real PATH and against one where `rg` is nowhere. */
describe('assertRipgrep', () => {
  const path = process.env.PATH;
  let empty = '';
  afterEach(async () => {
    process.env.PATH = path;
    if (empty) await rm(empty, { recursive: true, force: true });
    empty = '';
  });

  it('passes where rg is on the PATH', async () => {
    await expect(assertRipgrep()).resolves.toBeUndefined();
  });

  it('refuses to boot without rg, naming the binary and the Dockerfile that installs it', async () => {
    empty = await mkdtemp(join(tmpdir(), 'no-rg-'));
    process.env.PATH = empty;
    const err = (await assertRipgrep().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^ripgrep \(`rg`\) is required on the server's PATH but could not be run: .*ENOENT/);
    expect(err.message).toContain('The Hexis Dockerfile installs it');
  });
});
