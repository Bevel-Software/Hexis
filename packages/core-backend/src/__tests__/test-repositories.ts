import fs from 'node:fs/promises';

/**
 * The repository roots `testKbRepository` placed beside a suite's workspaces
 * root (`<workspacesRoot>.repository`). A suite removes its fixture root, not
 * what sits next to it, so `test-setup.ts` removes these once the file's
 * suites are done. Kept free of imports so the setup file can load it without
 * pulling in a module a suite means to mock.
 */
const roots = new Set<string>();

export function recordTestRepositoryRoot(root: string): void {
  roots.add(root);
}

export async function removeTestRepositoryRoots(): Promise<void> {
  const pending = [...roots];
  roots.clear();
  await Promise.all(
    pending.map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
}
