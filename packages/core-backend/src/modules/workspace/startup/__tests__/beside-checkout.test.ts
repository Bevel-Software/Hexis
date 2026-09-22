import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BESIDE_CHECKOUT_NOTE, noteBesideCheckout } from '../beside-checkout.js';

/**
 * Strays that already exist on a running deployment are NAMED at boot and
 * touched by nothing. The normaliser stops new ones being made; this scan is
 * the only way anyone learns about the old ones, now that the explorer reads
 * its roots from the checkout and no longer shows them.
 */

const KB = 'knowledge-base';

let root = '';
let notes: string[] = [];

const scan = () => noteBesideCheckout(root, KB, (line) => notes.push(line));

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

describe('noteBesideCheckout', () => {
  it('names every file and folder beside the checkout in one note, and deletes nothing', async () => {
    // Exactly what was found on core-staging on 2026-09-22.
    const dir = await workspace('main', {
      dirs: ['KnowledgeBase', 'Plugins'],
      files: ['TestJpg.jpg'],
    });

    await scan();

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
    await scan();
    expect(notes).toEqual([]);
  });

  it('marks the folders with a trailing slash so one line says which is which', async () => {
    await workspace('main', { dirs: ['Reports'], files: ['Reports.md'] });
    await scan();
    expect(notes[0]).toContain(`${BESIDE_CHECKOUT_NOTE} "Reports.md", "Reports/"`);
  });

  it('gives each workspace its own note, and none to the clean ones', async () => {
    await workspace('main', { files: ['stray.md'] });
    await workspace('alice%2Fdraft');
    await workspace('bob%2Fdraft', { dirs: ['Uploads'] });

    await scan();

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
    await noteBesideCheckout(root, 'kb', (line) => notes.push(line));

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`${BESIDE_CHECKOUT_NOTE} "${KB}/"`);
  });

  // A stray's name is disk-controlled text going into an operator's log, and
  // the filesystem allows a newline or a raw CSI in it. Escaped, the note stays
  // ONE line and cannot forge a second or paint the terminal — the reason every
  // name goes through `printable`, asserted here rather than left to the
  // incidental quoting the other cases see.
  it.runIf(process.platform !== 'win32')('escapes a stray name that could forge a line or steer the terminal', async () => {
    await workspace('main', { files: ['bad\nname.md'], dirs: ['CSI\u009Bdir'] });

    await scan();

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('"CSI\\u009bdir/"');
    expect(notes[0]).toContain('"bad\\nname.md"');
    // Nothing raw survived into the line, and the line is still one line.
    expect(notes[0]).not.toContain('\u009B');
    expect(notes[0].split('\n')).toHaveLength(1);
  });

  it('is quiet on a cold start, with no workspaces root on disk yet', async () => {
    await noteBesideCheckout(path.join(root, 'not-yet'), KB, (line) => notes.push(line));
    expect(notes).toEqual([]);
  });

  it('ignores a file sitting in the workspaces root itself — a workspace is a directory', async () => {
    await fs.writeFile(path.join(root, '.DS_Store'), '', 'utf-8');
    await workspace('main');
    await scan();
    expect(notes).toEqual([]);
  });
});
