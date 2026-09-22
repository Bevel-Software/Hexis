import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BESIDE_CHECKOUT_NOTE, BesideCheckoutStep } from '../beside-checkout.step.js';

/**
 * Strays that already exist on a running deployment are NAMED at boot and
 * touched by nothing. The normaliser stops new ones being made; this step is
 * the only way anyone learns about the old ones, now that the explorer reads
 * its roots from the checkout and no longer shows them.
 */

const KB = 'knowledge-base';

let root = '';
let notes: string[] = [];

const step = () => new BesideCheckoutStep(root, KB, (line) => notes.push(line));

/** A workspace directory holding a checkout, plus whatever `strays` name. */
async function workspace(id: string, strays: { dirs?: string[]; files?: string[] } = {}): Promise<string> {
  const dir = path.join(root, id);
  await fs.mkdir(path.join(dir, KB, '.git'), { recursive: true });
  for (const d of strays.dirs ?? []) await fs.mkdir(path.join(dir, d), { recursive: true });
  for (const f of strays.files ?? []) await fs.writeFile(path.join(dir, f), 'x', 'utf-8');
  return dir;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'beside-checkout-'));
  notes = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('BesideCheckoutStep', () => {
  it('names every file and folder beside the checkout in one note, and deletes nothing', async () => {
    // Exactly what was found on core-staging on 2026-09-22.
    const dir = await workspace('main', {
      dirs: ['KnowledgeBase', 'Plugins'],
      files: ['TestJpg.jpg'],
    });

    expect(await step().run()).toEqual({ outcome: 'ok' });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`${BESIDE_CHECKOUT_NOTE} "KnowledgeBase/", "Plugins/", "TestJpg.jpg"`);
    expect(notes[0]).toContain('"main"');
    // Named, not touched.
    for (const entry of ['KnowledgeBase', 'Plugins', 'TestJpg.jpg', KB]) {
      await expect(fs.stat(path.join(dir, entry))).resolves.toBeTruthy();
    }
  });

  it('says nothing when the checkout is all there is', async () => {
    await workspace('main');
    expect(await step().run()).toEqual({ outcome: 'ok' });
    expect(notes).toEqual([]);
  });

  it('marks the folders with a trailing slash so one line says which is which', async () => {
    await workspace('main', { dirs: ['Reports'], files: ['Reports.md'] });
    await step().run();
    expect(notes[0]).toContain(`${BESIDE_CHECKOUT_NOTE} "Reports.md", "Reports/"`);
  });

  it('gives each workspace its own note, and none to the clean ones', async () => {
    await workspace('main', { files: ['stray.md'] });
    await workspace('alice%2Fdraft');
    await workspace('bob%2Fdraft', { dirs: ['Uploads'] });

    await step().run();

    expect(notes).toHaveLength(2);
    expect(notes.some((n) => n.includes('"stray.md"') && n.includes('"main"'))).toBe(true);
    expect(notes.some((n) => n.includes('"Uploads/"') && n.includes('"bob%2Fdraft"'))).toBe(true);
  });

  it('names the checkout folder itself never, whatever the deployment calls it', async () => {
    const dir = path.join(root, 'main');
    await fs.mkdir(path.join(dir, 'kb', '.git'), { recursive: true });
    await fs.mkdir(path.join(dir, KB), { recursive: true });

    // With `kb` configured as the clone folder, a `knowledge-base/` directory
    // IS a stray — ordinary content nobody commits — and is named as one.
    await new BesideCheckoutStep(root, 'kb', (line) => notes.push(line)).run();

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`${BESIDE_CHECKOUT_NOTE} "${KB}/"`);
  });

  it('is quiet on a cold start, with no workspaces root on disk yet', async () => {
    const missing = new BesideCheckoutStep(path.join(root, 'not-yet'), KB, (line) => notes.push(line));
    expect(await missing.run()).toEqual({ outcome: 'ok' });
    expect(notes).toEqual([]);
  });

  it('ignores a file sitting in the workspaces root itself — a workspace is a directory', async () => {
    await fs.writeFile(path.join(root, '.DS_Store'), '', 'utf-8');
    await workspace('main');
    await step().run();
    expect(notes).toEqual([]);
  });
});
