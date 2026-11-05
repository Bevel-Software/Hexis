import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setAsideRootFor } from '../../modules/workspace/set-aside-clone.js';

/**
 * A working copy of a repository that is no longer the configured one is SET
 * ASIDE rather than deleted, and two places do it: the KB startup phase,
 * sweeping the whole workspaces root, and the workspace service, refusing to
 * adopt one on a branch open. They must set aside into ONE directory.
 *
 * They did not. The composition root gave the phase a root under the backups
 * volume and the workspace service nothing at all, so that one fell back to a
 * sibling of the workspaces root — which in the shipped compose file is the
 * container's own filesystem, not a volume. A copy the workspace service kept
 * was therefore gone at the next ordinary recreate, after the setup screen had
 * told the admin it was being kept and where to find it.
 *
 * Read off the source, like `migrations-unqualified.test.ts` reads the
 * migrations: the wiring is a single call graph that cannot be built in a unit
 * test (it wants a database, a git host and a disk), and the invariant is
 * about the TEXT — that the folder is named once and that one name reaches
 * both. A second literal is exactly how the two came apart.
 */

const compositionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../create-core-services.ts',
);

describe('the set-aside root the composition root wires', () => {
  it('is named once, and handed to both the startup phase and the workspace service', async () => {
    const source = await fs.readFile(compositionRoot, 'utf8');

    // Named once. Two occurrences means two expressions, which is how a
    // change to one of them silently stops applying to the other.
    const literals = source.match(/'replaced-working-copies'/g) ?? [];
    expect(literals).toHaveLength(1);

    // And that one name is rooted at the backups volume, which the deployment
    // mounts — not at the workspaces root's parent, which it does not.
    expect(source).toMatch(
      /const replacedWorkingCopiesRoot = path\.join\(config\.backupsRoot, 'replaced-working-copies'\)/,
    );

    // Both consumers read the one variable.
    expect(source).toMatch(/new WorkspaceService\([\s\S]*?replacedWorkingCopiesRoot,[\s\S]*?\);/);
    expect(source).toMatch(/setAsideRoot: replacedWorkingCopiesRoot,/);
  });
});

describe('setAsideRootFor', () => {
  it('uses the root it is given, whatever the workspaces root is', () => {
    expect(setAsideRootFor('/app/apps/server/workspaces', '/app/apps/server/backups/replaced-working-copies')).toBe(
      '/app/apps/server/backups/replaced-working-copies',
    );
  });

  it('falls back beside the workspaces root — a place a container deployment must not rely on', () => {
    expect(setAsideRootFor('/app/apps/server/workspaces')).toBe('/app/apps/server/replaced-working-copies');
  });
});
