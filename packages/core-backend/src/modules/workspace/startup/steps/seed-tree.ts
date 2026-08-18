import fs from 'node:fs/promises';
import path from 'node:path';
import { renderRolesYaml } from '../../../access/render-roles-yaml.js';
import { TEMPLATE_SOURCE_FALLBACKS, reservedRootDirs, templateSource } from './template-files.step.js';

/**
 * The empty-remote seed builder the runner takes as `buildSeedTree`: the full
 * template tree, every reserved root, and a generated roles.yaml. DIRECT fs
 * writes are correct here — the target is a temp directory the runner inits,
 * commits and pushes itself, not a branch handle with buffered ops.
 *
 * Resolves to the repo-relative paths it GENERATED (roles.yaml plus each
 * reserved root's .gitkeep): a template `.gitignore` rule could match any of
 * them, and the runner force-adds them after `git add -A` so a required seed
 * file can never be silently dropped from the seed commit.
 *
 * `extraRootDirs` is validated eagerly, at composition time: a bad value
 * should fail at boot beside the rest of the wiring, not mid-seed of
 * somebody's knowledge base.
 */
export function buildSeedTree(
  templateDir: string,
  extraRootDirs: readonly string[],
  seedAdminEmails: readonly string[],
): (dir: string) => Promise<string[]> {
  const requiredDirs = reservedRootDirs(extraRootDirs);
  return async (dir) => {
    const generated: string[] = [];
    await copyTemplateTree(templateDir, dir);
    // Reserved roots the template does not carry. Without this the seed commit
    // would hold only what the template has, and a distribution's own roots
    // would appear a step later, when the first startup phase tops them up —
    // the same folders, arriving in a second commit for no reason. Keyed on
    // the DIRECTORY's existence: a template already carrying content under a
    // root never gets a pointless placeholder beside it.
    for (const rootDir of requiredDirs) {
      const abs = path.join(dir, rootDir);
      const found = await lstatOrNull(abs);
      if (found) {
        if (found.isDirectory()) continue;
        // Only a template shipping a FILE under a reserved name reaches this —
        // a broken build, not a broken knowledge base.
        throw new Error(`KB root "${rootDir}" exists in the template but is not a directory.`);
      }
      await fs.mkdir(abs, { recursive: true });
      await fs.writeFile(path.join(abs, '.gitkeep'), '', 'utf8');
      generated.push(`${rootDir}/.gitkeep`);
    }
    // Generated, never templated — see roles-yaml.step.ts. The runner refuses
    // to seed an empty remote with no admins, so the list is non-empty here.
    await fs.writeFile(path.join(dir, 'roles.yaml'), renderRolesYaml(seedAdminEmails), 'utf8');
    generated.push('roles.yaml');
    return generated;
  };
}

/** Copy the entire template tree into `dest` (roles.yaml isn't in it — it's generated). */
async function copyTemplateTree(templateDir: string, dest: string): Promise<void> {
  const packableToReal = new Map(
    Object.entries(TEMPLATE_SOURCE_FALLBACKS).map(([real, packable]) => [packable, real]),
  );
  const walk = async (relDir: string): Promise<void> => {
    const abs = path.join(templateDir, relDir);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      // Never copy a git dir: a KB_TEMPLATE_DIR that is itself a working tree
      // (this repo in a Docker build) must not seed its history into the KB.
      if (entry.name === '.git') continue;
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(rel);
        continue;
      }
      // A packable spelling at the template root seeds under its REAL name
      // — unless the template also carries the literal file (a
      // distribution's own template), which wins and is copied by its own
      // walk entry; copying the packable twin too would clobber it.
      const realName = relDir === '' ? packableToReal.get(entry.name) : undefined;
      if (realName !== undefined) {
        if (!(await exists(path.join(templateDir, realName)))) {
          await copyTemplateFile(templateDir, realName, dest);
        }
        continue;
      }
      await copyTemplateFile(templateDir, rel, dest);
    }
  };
  await walk('');
}

/** Copy one template file (by repo-relative path) into `dest`, creating parents. */
async function copyTemplateFile(templateDir: string, relPath: string, dest: string): Promise<void> {
  const from = await templateSource(templateDir, relPath);
  const to = path.join(dest, relPath);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** `lstat` without the throw — null when nothing is at `p`. */
async function lstatOrNull(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}
