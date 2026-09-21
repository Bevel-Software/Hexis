import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AGENTS_FILE,
  LEGACY_AGENTS_FILE,
  renderKbLayoutPlaceholders,
} from '@bevel-software/platform-shared';
import type { IFsProbe, ITreeWalker } from '../../../../shared/fs.contract.js';
import { renderRolesYaml } from '../../../access-model/render-roles-yaml.js';
import { reservedRootDirs } from './template-files.step.js';
import { TEMPLATE_SOURCE_FALLBACKS, TemplateSource } from './template-source.js';
import { assertNotGitInternals, hasGitInternalsSegment } from '../../../../shared/git-internals.js';
import { GitInternalsError } from '../../../../shared/domain-errors.js';

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
 *
 * A factory over {@link KbSeedTree} rather than the class itself, because the
 * runner's port is a function: it asks for a directory to be filled and gets
 * back what was generated, and knows nothing of templates or disks.
 */
export function buildSeedTree(
  disk: IFsProbe & ITreeWalker,
  templateDir: string,
  extraRootDirs: readonly string[],
  seedAdminEmails: readonly string[],
): (dir: string) => Promise<string[]> {
  // Validated eagerly; resolved per seed. The core roots are live bindings the
  // setup-completing save may configure after this builder was composed.
  reservedRootDirs(extraRootDirs);
  const seeder = new KbSeedTree(disk, new TemplateSource(disk, templateDir), extraRootDirs, seedAdminEmails);
  return (dir) => seeder.seed(dir);
}

/**
 * Seeding a fresh knowledge base into an empty directory.
 *
 * The walker and the template are held, not passed: every step of a seed —
 * the tree copy, one file's copy, the link check — reads the SAME template
 * through the SAME disk, and threading both through each helper's signature
 * only created places where a future caller could pass a different one.
 */
class KbSeedTree {
  constructor(
    private readonly disk: ITreeWalker & IFsProbe,
    private readonly templates: TemplateSource,
    private readonly extraRootDirs: readonly string[],
    private readonly seedAdminEmails: readonly string[],
  ) {}

  /** Fill `dir` with a complete knowledge base; resolve to what was GENERATED. */
  async seed(dir: string): Promise<string[]> {
    const generated: string[] = [];
    await this.copyTemplateTree(dir);
    // Reserved roots the template does not carry. Without this the seed commit
    // would hold only what the template has, and a distribution's own roots
    // would appear a step later, when the first startup phase tops them up —
    // the same folders, arriving in a second commit for no reason. Keyed on
    // the DIRECTORY's existence: a template already carrying content under a
    // root never gets a pointless placeholder beside it.
    // Resolved NOW, not when the builder was composed: a seed that runs on the
    // save completing first-run setup must lay down the names that save applied.
    for (const rootDir of reservedRootDirs(this.extraRootDirs)) {
      const abs = path.join(dir, rootDir);
      const found = await this.disk.lstatOrNull(abs);
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
    await fs.writeFile(path.join(dir, 'roles.yaml'), renderRolesYaml(this.seedAdminEmails), 'utf8');
    generated.push('roles.yaml');
    return generated;
  }

  /** Copy the entire template tree into `dest` (roles.yaml isn't in it — it's generated). */
  private async copyTemplateTree(dest: string): Promise<void> {
    // A template that is not there is a broken build, not an empty seed.
    const templateStat = await this.templates.rootStat();
    if (templateStat === null || !templateStat.isDirectory()) {
      throw new Error(`KB template "${this.templates.root}" is not a directory.`);
    }
    // Never copy a git dir: a KB_TEMPLATE_DIR that is itself a working tree
    // (this repo in a Docker build) must not seed its history into the KB.
    // Every other entry is template content, dot-files included.
    await this.disk.walk(this.templates.root, { skip: (e) => hasGitInternalsSegment(e.name), unreadable: 'throw' }, [
      {
        onFile: (relDir, name) => this.seedFile(relDir, name, dest),
        onOther: async (relDir, entry) => {
          // A template may LINK to a file (a distribution's checkout, a Docker
          // build's copy): its content is template content, read through the
          // link and seeded under the link's own name like any file. Anything
          // else — a link to a folder or to nothing, a socket — is a broken
          // template, and the error says what was found.
          const rel = relDir ? path.join(relDir, entry.name) : entry.name;
          // A link whose target is inside a git folder is not template
          // content, whatever it is named: seeding it would copy a working
          // tree's `.git/config` into the KB as an ordinary file. The name
          // check above cannot see this — only the resolved target can.
          if (await linksIntoGitInternals(this.templates.root, rel)) return;
          const target = await this.templates.statOf(rel);
          if (target === null || !target.isFile()) {
            const what = target === null ? 'nothing' : target.isDirectory() ? 'a directory' : 'a special file';
            throw new Error(
              `KB template entry "${rel}" ${entry.isSymbolicLink() ? `links to ${what}` : `is ${what}`} — a template holds regular files, or links to them.`,
            );
          }
          await this.seedFile(relDir, entry.name, dest);
        },
      },
    ]);
  }

  /** Seed one template file, by the name the walk saw it under. */
  private async seedFile(relDir: string, name: string, dest: string): Promise<void> {
    // A packable spelling at the template root seeds under its REAL name
    // — unless the template also carries the literal file (a
    // distribution's own template), which wins and is copied by its own
    // walk entry; copying the packable twin too would clobber it.
    const realName = relDir === '' ? PACKABLE_TO_REAL.get(name) : undefined;
    if (realName !== undefined) {
      if (!(await this.templates.carries(realName))) {
        await this.copyTemplateFile(realName, dest);
      }
      return;
    }
    // The agent guide ships under one name and lands under this deployment's.
    // Done HERE rather than left to the top-up step, which would otherwise
    // write the guide under its configured name and then delete the
    // `AGENTS.md` this seed had just laid down — two commits saying opposite
    // things about a knowledge base nobody had used yet.
    if (relDir === '' && name === LEGACY_AGENTS_FILE) {
      await this.copyTemplateFile(name, dest, AGENTS_FILE);
      return;
    }
    await this.copyTemplateFile(relDir ? path.join(relDir, name) : name, dest);
  }

  /**
   * Copy one template file (by repo-relative path) into `dest`, creating
   * parents. `destRel` is the name it lands under when that differs from the
   * template's — true of the agent guide and nothing else. Text files are RENDERED — the managed guide and the ignore file
   * name the three root folders, which a deployment may have renamed — and a
   * file without placeholders comes out byte-identical to its source.
   *
   * "Text" is decided by the BYTES, not the name: strict UTF-8 with no NUL.
   * A name-based rule mistook a hidden binary for text and re-encoded it;
   * anything that does not decode is copied byte for byte. Either way the
   * source's mode survives — a template script keeps its executable bit.
   */
  private async copyTemplateFile(relPath: string, dest: string, destRel: string = relPath): Promise<void> {
    const from = await this.templates.pathOf(relPath);
    const to = path.join(dest, destRel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    // A binary is spotted from its first bytes (a NUL turns up early in any
    // real one) and streamed across without ever being read whole; only what
    // may be text is read in full, and the full decode is still the judge.
    const text = (await headHasNul(from)) ? null : asText(await fs.readFile(from));
    if (text === null) {
      await fs.copyFile(from, to);
    } else {
      await fs.writeFile(to, renderKbLayoutPlaceholders(text), 'utf8');
    }
    await fs.chmod(to, (await fs.stat(from)).mode & 0o777);
  }
}

/** The packable spelling a template may carry → the name it seeds under. */
const PACKABLE_TO_REAL = new Map([...TEMPLATE_SOURCE_FALLBACKS].map(([real, packable]) => [packable, real]));

/** Whether the first 8 KiB carry a NUL byte — the cheap half of "is this text". */
async function headHasNul(file: string): Promise<boolean> {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** The bytes as text when they ARE text — strict UTF-8, BOM kept, no NUL — else null. */
function asText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Whether `rel` under `templateRoot` resolves inside a git folder — the
 * template entry is a link, and following it would read the repository's own
 * git data. Judged on the resolved path, so a link out of the template into
 * some other checkout's `.git` counts too.
 */
async function linksIntoGitInternals(templateRoot: string, rel: string): Promise<boolean> {
  try {
    await assertNotGitInternals(templateRoot, rel);
    return false;
  } catch (err) {
    if (err instanceof GitInternalsError) return true;
    throw err;
  }
}
