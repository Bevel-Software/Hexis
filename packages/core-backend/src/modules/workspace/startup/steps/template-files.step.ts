import fs from 'node:fs/promises';
import path from 'node:path';
import { KNOWLEDGE_BASE_DIR, PLUGINS_DIR } from '@bevel-software/platform-shared';
import { IGNORE_FILENAME } from '../../bevel-ignore.js';
import type { KbBranch, OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

/**
 * The **required scaffolding** — the minimum an operational KB needs. Any of
 * these missing from a protected branch are added at the startup phase; the
 * sample ontology is NOT (it only seeds a fully-empty repo, see seed-tree.ts).
 *
 * Two kinds:
 *  - {@link REQUIRED_FILES}: repo-root files added when the file is missing.
 *  - Reserved root dirs (core's two plus a distribution's `extraRootDirs`):
 *    when a dir is entirely absent it's created by adding its `<dir>/.gitkeep`.
 *    Keyed on the *directory's* existence, not the `.gitkeep` file — so a
 *    branch that already has content under `KnowledgeBase/` never gets a
 *    pointless placeholder.
 *
 * `roles.yaml` is in neither, and is not part of the template at all: it is
 * generated from `ADMIN_EMAIL` (see roles-yaml.step.ts), so a repo can't be
 * seeded with a stale hard-coded Admin list.
 */
export const REQUIRED_FILES: readonly string[] = ['access.md', 'AGENTS.md', '.bevelignore', '.gitignore'];

/**
 * Destination name → the packable spelling the template may carry instead.
 * npm strips every file named `.gitignore` from a published tarball, so the
 * packaged template cannot ship one under its real name (see
 * {@link templateSource}).
 */
export const TEMPLATE_SOURCE_FALLBACKS: Readonly<Record<string, string>> = {
  '.gitignore': 'gitignore.template',
};

/**
 * The two roots CORE gives a knowledge base: the ontologies, and the plugins
 * that hold skills and tools.
 *
 * `Data/`, `Agents/` and `Pipelines/` are deliberately absent. They scaffold
 * the agentic execution layer, which is not part of this platform — a core
 * deployment that created them would be handing every operator three empty
 * folders it has no feature to fill. A distribution that DOES own that layer
 * passes them as `extraRootDirs` (and ships a template carrying their
 * READMEs); the names stay reserved in `kb-layout.ts` either way, so a KB
 * that has them still renders them as roots rather than folding them into
 * Knowledge.
 */
const CORE_REQUIRED_DIRS: readonly string[] = [KNOWLEDGE_BASE_DIR, PLUGINS_DIR];

/**
 * A reserved root must be ONE path segment — `Data`, not `Data/x`, `../x` or
 * `/x`. The name is joined onto the repo root, so anything else writes outside
 * the repo being maintained.
 *
 * Deliberately NOT a check against the reserved-root set in `kb-layout.ts`:
 * `Data`, `Agents` and `Pipelines` are all in that set, and they are precisely
 * what a distribution passes here. Being reserved is what makes a name worth
 * claiming — the file tree renders it as its own root instead of folding it
 * into Knowledge — so rejecting reserved names would reject the only real use.
 */
function assertRootSegment(dir: string): void {
  if (!dir || dir === '.' || dir === '..' || dir.includes('/') || dir.includes('\\') || path.isAbsolute(dir)) {
    throw new Error(`Reserved KB root must be a single path segment (no separators, no ".."); got "${dir}"`);
  }
}

/**
 * Core's guaranteed roots plus a distribution's extras, validated once at
 * composition time: every entry is joined onto the repo root and onto
 * `<dir>/.gitkeep`, so a separator or a `..` would write outside the repo
 * being maintained, and a bad value should fail at boot beside the rest of
 * the wiring rather than part-way through maintaining somebody's knowledge
 * base. Shared with the empty-remote seed builder (seed-tree.ts) so the two
 * paths can never disagree about what a deployment guarantees.
 */
export function reservedRootDirs(extraRootDirs: readonly string[]): readonly string[] {
  for (const dir of extraRootDirs) {
    assertRootSegment(dir);
    // A root named after a required FILE is a typo with a silent outcome:
    // the file is laid down first, so the dir check finds the path taken and
    // skips it, and the directory the caller asked for never appears with
    // nothing said about why.
    if (REQUIRED_FILES.includes(dir)) {
      throw new Error(`Reserved KB root "${dir}" collides with a required file of the same name`);
    }
  }
  return [...CORE_REQUIRED_DIRS, ...extraRootDirs];
}

/**
 * Where `relPath`'s template content actually lives. npm refuses to pack
 * files named `.gitignore` — every such file is silently stripped from the
 * published tarball — so the packaged template ships the KB's gitignore
 * under a packable name and the seeder writes it to its real one. A
 * template carrying the literal file (a distribution's own
 * KB_TEMPLATE_DIR, or this repo's tree in a Docker build) wins outright:
 * the mapping is a fallback, never a rename.
 */
export async function templateSource(templateDir: string, relPath: string): Promise<string> {
  const direct = path.join(templateDir, relPath);
  if (await exists(direct)) return direct;
  const packable = TEMPLATE_SOURCE_FALLBACKS[relPath];
  if (packable !== undefined) {
    const fallback = path.join(templateDir, packable);
    if (await exists(fallback)) return fallback;
  }
  return direct; // let the ENOENT surface under the name the caller asked for
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

/**
 * The template top-up as an {@link OnServerStart} step: add any missing base
 * scaffolding to every PROTECTED branch, and keep the managed AGENTS.md
 * current. Drafts are deliberately out of scope — whatever the protected
 * branches gain, drafts fork from; a scaffolding addition on a draft would
 * surface as noise in its change request's diff. (Unlike the Groups→Plugins
 * rename, a missing file diffs as one file, not the whole tree — so the
 * uniform-application argument does not bite here.)
 *
 * Everything is DECLARED on the branch handle; reads go against the pre-step
 * tree via `repoDir()`. Fail-open behavior from the lazy top-up (best-effort,
 * never throws) is deliberately gone: an unexpected state — a file squatting
 * a reserved root name — now throws and stops the boot, which is the phase's
 * contract for states a human must look at.
 */
export class TemplateFilesStep implements OnServerStart {
  readonly name = 'template-files';

  private readonly requiredDirs: readonly string[];

  /**
   * @param extraRootDirs Additional root folders this distribution reserves,
   *                      on top of core's two. Their `.gitkeep` is written
   *                      directly rather than copied, so a distribution can
   *                      claim a root without also shipping a template entry
   *                      for it.
   */
  constructor(extraRootDirs: readonly string[] = []) {
    this.requiredDirs = reservedRootDirs(extraRootDirs);
  }

  async run(ctx: ServerStartContext): Promise<StepResult> {
    for (const branch of await ctx.protectedBranches()) {
      await this.topUp(ctx.templateDir, branch);
    }
    return { outcome: 'ok' };
  }

  private async topUp(templateDir: string, branch: KbBranch): Promise<void> {
    const repoDir = await branch.repoDir();
    const added: string[] = [];

    for (const rel of REQUIRED_FILES) {
      if (await exists(path.join(repoDir, rel))) continue;
      branch.write(rel, await readTemplate(templateDir, rel));
      added.push(rel);
      // Adding AGENTS.md to a knowledge base seeded before the rename
      // leaves it VISIBLE: that repo's `.bevelignore` lists CLAUDE.md and
      // knows nothing of the new name, so the conventions doc starts
      // showing up in the file tree and the agent view. We created the
      // mismatch by adding the file, so we close it here.
      if (rel === 'AGENTS.md') added.push(...(await mergeIgnorePattern(repoDir, branch, rel)));
    }

    // AGENTS.md is MANAGED, not merely seeded: the platform owns its content,
    // and a stale copy is replaced with the packaged template's every startup
    // phase. The file's own header says so, which is what makes overwriting
    // edits a stated contract instead of a surprise.
    let agentsRefreshed = false;
    if (!added.includes('AGENTS.md') && (await templateDiffers(templateDir, repoDir, 'AGENTS.md'))) {
      branch.write('AGENTS.md', await readTemplate(templateDir, 'AGENTS.md'));
      added.push('AGENTS.md');
      agentsRefreshed = true;
    }

    added.push(...this.ensureRequiredDirs(repoDir, branch, await this.missingDirs(repoDir)));

    if (added.length === 0) return;
    // One honest line; it becomes the commit subject when this step is the
    // first to dirty the branch.
    branch.note(
      agentsRefreshed && added.length === 1
        ? 'Update AGENTS.md to the current platform template'
        : `Add missing KB scaffolding: ${added.join(', ')}`,
    );
  }

  /**
   * Which reserved roots are absent — and which are SQUATTED. `lstat`, not
   * `exists`: `fs.access` answers "is there something here?", which is true of
   * a FILE named `Plugins` — and a skip-if-present check would then do nothing
   * and report success, leaving a knowledge base permanently missing a root it
   * claims to guarantee. `lstat` rather than `stat` so a SYMLINK is rejected
   * too: a link named `Plugins` is not a KB layout, and one pointing outside
   * the repo would make every later write into it land somewhere nobody asked
   * for. A squatter THROWS — under this phase's fail-closed contract that
   * stops the boot, which such a state deserves.
   */
  private async missingDirs(repoDir: string): Promise<string[]> {
    const missing: string[] = [];
    for (const rootDir of this.requiredDirs) {
      const found = await lstatOrNull(path.join(repoDir, rootDir));
      if (found) {
        if (found.isDirectory()) continue;
        throw new Error(
          `KB root "${rootDir}" exists but is not a directory ` +
            `(${found.isSymbolicLink() ? 'symlink' : 'file'}). Remove or rename it — ` +
            'the platform requires this name to be a folder.',
        );
      }
      missing.push(rootDir);
    }
    return missing;
  }

  /**
   * Declare each missing reserved root as an empty `<dir>/.gitkeep`.
   * WRITTEN, not copied from the template: a `.gitkeep` is empty by
   * definition, and requiring a template entry per root would mean a
   * distribution could not reserve one without forking the packaged template.
   */
  private ensureRequiredDirs(repoDir: string, branch: KbBranch, missing: readonly string[]): string[] {
    const added: string[] = [];
    for (const rootDir of missing) {
      branch.write(`${rootDir}/.gitkeep`, '');
      added.push(`${rootDir}/.gitkeep`);
    }
    return added;
  }
}

/** The template's content for `relPath`, bytes as shipped. */
async function readTemplate(templateDir: string, relPath: string): Promise<Uint8Array> {
  return fs.readFile(await templateSource(templateDir, relPath));
}

/**
 * Whether the repo's copy of `relPath` differs from the template's, modulo
 * line endings — a CRLF checkout of identical content must read as "same",
 * or the managed-file refresh would commit churn on every boot forever.
 */
async function templateDiffers(templateDir: string, repoDir: string, relPath: string): Promise<boolean> {
  const norm = (text: string) => text.replace(/\r\n?/g, '\n');
  const [current, template] = await Promise.all([
    fs.readFile(path.join(repoDir, relPath), 'utf8'),
    templateSource(templateDir, relPath).then((from) => fs.readFile(from, 'utf8')),
  ]);
  return norm(current) !== norm(template);
}

/**
 * Ensure `.bevelignore` carries `pattern`, declaring the appended content when
 * absent. Returns the paths changed, for the note.
 *
 * APPENDS — never rewrites. The file is the operator's, and every rule
 * already in it is theirs to keep; this adds one line under a comment saying
 * where it came from. Absent file, or a file that already lists the pattern,
 * is a no-op — an absent file means the template's copy (declared in the same
 * step) arrives with the pattern in it.
 *
 * Matched line-wise rather than by substring: a rule for `Plugins/AGENTS.md`
 * is not a rule for the root `AGENTS.md`, and treating it as one would leave
 * the mismatch this exists to close.
 */
async function mergeIgnorePattern(repoDir: string, branch: KbBranch, pattern: string): Promise<string[]> {
  let current: string;
  try {
    current = await fs.readFile(path.join(repoDir, IGNORE_FILENAME), 'utf8');
  } catch {
    return []; // No ignore file — the template's copy arrives with the pattern in it.
  }
  const lines = current.split('\n').map((l) => l.trim());
  if (lines.includes(pattern)) return [];
  const separator = current.endsWith('\n') ? '' : '\n';
  branch.write(
    IGNORE_FILENAME,
    `${current}${separator}\n# Added by the platform: the conventions doc is not node content.\n${pattern}\n`,
  );
  return [IGNORE_FILENAME];
}
