import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentGuideDir, coreMigrationsDir, defaultKbTemplateDir } from '../assets.js';

/**
 * Every asset folder this package reads at run time has to reach the places
 * the package is shipped from: the npm tarball (`files` in package.json) and
 * the Docker image (the runtime stage of the repository's Dockerfile, which
 * copies each folder by name).
 *
 * The second list is the one nothing else checks. `agent-guide/` was added to
 * `assets.ts` and to `files`, but not to the Dockerfile, and no test or CI job
 * builds the image: the folder was simply absent from every image built from
 * dev. It is read while the tool list is composed, so the first request for
 * any tool on the deployment failed, and every agent surface with it
 * (2026-10-06). A folder named here and missing from either list fails this
 * test instead.
 */
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const repoRoot = path.resolve(packageRoot, '..', '..');

/** The folders assets.ts locates, as names under the package root. */
const ASSET_DIRS = [coreMigrationsDir(), defaultKbTemplateDir(), agentGuideDir()].map((dir) =>
  path.basename(dir),
);

describe('the asset folders this package reads at run time', () => {
  it('are the three assets.ts names', () => {
    expect(ASSET_DIRS.sort()).toEqual(['agent-guide', 'kb-template', 'migrations']);
  });

  it('exist in the source tree', () => {
    for (const dir of ASSET_DIRS) {
      expect(fs.statSync(path.join(packageRoot, dir)).isDirectory(), dir).toBe(true);
    }
  });

  it('are in the npm tarball', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { files: string[] };
    for (const dir of ASSET_DIRS) {
      expect(pkg.files, `${dir} missing from package.json "files"`).toContain(dir);
    }
  });

  it('are copied into the Docker image by the runtime stage', () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
    for (const dir of ASSET_DIRS) {
      const line = `COPY --from=builder /app/packages/core-backend/${dir} packages/core-backend/${dir}`;
      expect(dockerfile, `Dockerfile does not copy ${dir} into the image`).toContain(line);
    }
  });
});
