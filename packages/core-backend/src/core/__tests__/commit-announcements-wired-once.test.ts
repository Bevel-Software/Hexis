import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A landed commit is announced from ONE place. The git service reports every
 * commit it lands through `VersionControlHooks.commitLanded`; the composition
 * root hands that to the file-change notifier with one registration; nothing
 * else emits on the notifier or calls the hook. A second announcer is how a
 * batch gets announced twice, and a committer that announces on its own is how
 * the next one forgets to — both were real findings on the release that made
 * this rule, so the rule is pinned at the source level.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(SRC, 'core', 'create-core-services.ts');

async function shippedSources(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') await shippedSources(full, out);
    } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function filesContaining(needle: RegExp): Promise<string[]> {
  const hits: string[] = [];
  for (const file of await shippedSources(SRC)) {
    if (needle.test(await fs.readFile(file, 'utf8'))) hits.push(path.relative(SRC, file).replace(/\\/g, '/'));
  }
  return hits.sort();
}

describe('commit announcements are wired once', () => {
  it('the composition root hands the git layer\'s landed commits to the notifier with one registration', async () => {
    const source = await fs.readFile(ROOT, 'utf8');
    const registrations = source.match(/versionControlHooks\.onCommitLanded\(/g) ?? [];
    expect(registrations).toHaveLength(1);
    expect(source).toContain('versionControlHooks.onCommitLanded((change) => fileChangeNotifier.emit(change));');
  });

  it('only the git service reports a landed commit, and only the root registers for it', async () => {
    expect(await filesContaining(/\.commitLanded\(/)).toEqual(['modules/version-control/git/git.service.ts']);
    expect(await filesContaining(/\.onCommitLanded\(/)).toEqual(['core/create-core-services.ts']);
  });

  it('nothing but the root emits on the notifier, and no committer announces on its own', async () => {
    expect(await filesContaining(/fileChangeNotifier\.emit\(|fileChanges\??\.emit\(/)).toEqual(['core/create-core-services.ts']);
    expect(await filesContaining(/announceCommitted|announceReleased/)).toEqual([]);
  });
});
