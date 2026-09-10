import fs from 'node:fs/promises';
import path from 'node:path';
import {
  KNOWLEDGE_BASE_DIR,
  PLUGINS_DIR,
  SKILLS_DIR,
  renderKbLayoutPlaceholders,
  validateKbRootName,
} from '@bevel-software/platform-shared';
import { IGNORE_FILENAME } from '../../bevel-ignore.js';
import { PREAMBLE_FILE } from '../../../agent-instructions/compose.js';
import { defaultKbTemplateDir } from '../../../../assets.js';
import type { KbBranch, OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

/** Root-anchored so a knowledge folder may still contain an ordinary namesake. */
const PREAMBLE_IGNORE_PATTERN = `/${PREAMBLE_FILE}`;

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
export const REQUIRED_FILES: readonly string[] = [
  'access.md',
  'AGENTS.md',
  '.bevelignore',
  '.gitignore',
  // The deployment preamble every connected agent is told at session start
  // (see modules/agent-instructions). Seeded ONCE and never refreshed: the
  // content is the admin's, and the shipped template is one HTML comment, so
  // a never-edited file sends nothing of its own.
  PREAMBLE_FILE,
];

/**
 * Required files added AFTER a distribution may have forked the template. A
 * custom `KB_TEMPLATE_DIR` that predates one of these would otherwise stop
 * the boot with ENOENT on the first start after an upgrade, on every
 * protected branch, over a file whose shipped content is one comment. For
 * these the packaged template's copy stands in, with one line in the log;
 * every other required file keeps the strict contract (a custom template
 * missing `access.md` is a real mistake and should fail loudly).
 */
export const PACKAGED_FALLBACK_FILES: ReadonlySet<string> = new Set([PREAMBLE_FILE]);

/**
 * Repo-root files the startup phase GENERATES rather than copies — today just
 * `roles.yaml`, rendered from `ADMIN_EMAIL` (see roles-yaml.step.ts and
 * seed-tree.ts). Reserved-root validation must treat these exactly like
 * {@link REQUIRED_FILES}: a root claiming a generated name is the same silent
 * typo with the same silent outcome.
 */
export const GENERATED_FILES: readonly string[] = ['roles.yaml'];

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
 * The three roots CORE gives a knowledge base: the ontologies, the shared
 * skills, and the plugins that hold tools and link the skills.
 *
 * `Data/`, `Agents/` and `Pipelines/` are deliberately absent. They scaffold
 * the agentic execution layer, which is not part of this platform — a core
 * deployment that created them would be handing every operator three empty
 * folders it has no feature to fill. A distribution that DOES own that layer
 * passes them as `extraRootDirs` (and ships a template carrying their
 * READMEs); the names stay reserved in `kb-layout.ts` either way, so a KB
 * that has them still renders them as roots rather than folding them into
 * Knowledge.
 *
 * A function: the three names are deployment-configurable live bindings, and
 * a module-scope array would snapshot the defaults before configuration.
 */
function coreRequiredDirs(): readonly string[] {
  return [KNOWLEDGE_BASE_DIR, SKILLS_DIR, PLUGINS_DIR];
}

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
  // `.git` can never be a KB root: writing `<dir>/.gitkeep` under it would
  // corrupt the clone's own metadata. Any case — Windows filesystems treat
  // `.GIT` as the same directory.
  if (dir.toLowerCase() === '.git') {
    throw new Error(`Reserved KB root must not be ".git" (any case); got "${dir}"`);
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
    // A root named after a required OR generated FILE is a typo with a silent
    // outcome: the file is laid down first, so the dir check finds the path
    // taken and skips it, and the directory the caller asked for never appears
    // with nothing said about why.
    if (REQUIRED_FILES.includes(dir) || GENERATED_FILES.includes(dir)) {
      throw new Error(
        `Reserved KB root "${dir}" collides with a required or generated file of the same name`,
      );
    }
  }
  return [...coreRequiredDirs(), ...extraRootDirs];
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
      // `lstat`, not `exists`: a DIRECTORY or SYMLINK squatting a required
      // file's name would read as "present", and a skip-if-present check
      // would then report success over a knowledge base whose root access
      // policy (say) cannot be read. Fail-closed, same as the reserved-root
      // squatting check below: this is a state a human must fix.
      const found = await lstatOrNull(path.join(repoDir, rel));
      if (found) {
        if (found.isFile()) continue;
        throw new Error(
          `Required KB file "${rel}" on branch "${branch.name}" exists but is not a regular file ` +
            `(${found.isSymbolicLink() ? 'symlink' : found.isDirectory() ? 'directory' : 'special file'}). ` +
            'Remove or rename it — the platform requires this name to be a readable file.',
        );
      }
      let content = await readTemplate(templateDir, rel);
      // The on-disk merge below only runs against an EXISTING ignore file; a
      // freshly-declared one was merely assumed to carry the AGENTS.md rule —
      // true of the packaged template, not necessarily of a distribution's
      // custom one. Make it true here, so the managed conventions doc is
      // hidden from the file tree from the first boot either way. The same is
      // true of the deployment preamble: it is edited through External agent
      // access, not as an ordinary knowledge-base document.
      // …and a template still shipping the skills rule an earlier release
      // had (a distribution's copy, a stale packaged one) must not declare
      // it: the on-disk reconciliation below never sees a file that was
      // absent, so the declared content is reconciled here instead.
      if (rel === IGNORE_FILENAME) {
        content = withoutIgnoreLine(
          withoutPlatformIgnorePattern(
            withIgnorePattern(withIgnorePattern(content, 'AGENTS.md'), PREAMBLE_IGNORE_PATTERN),
            `${SKILLS_DIR}/`,
          ),
          `${PLUGINS_DIR}/`,
        );
      }
      branch.write(rel, content);
      added.push(rel);
    }

    // AGENTS.md or mcp-description.md left VISIBLE by a stale `.bevelignore`
    // is closed here — and
    // UNCONDITIONALLY, not only when the file was just added: a KB whose
    // AGENTS.md predates the CLAUDE.md→AGENTS.md rename has an ignore file
    // that lists the old name and knows nothing of the new one, so the
    // conventions doc shows up in the file tree and the agent view.
    // Idempotent: an ignore file already carrying the rule — or absent, in
    // which case the template's copy declared above arrives with the rule in
    // it — changes nothing and produces no note. Deliberately checked by
    // LINE PRESENCE, not effective outcome: a later `!AGENTS.md` negation is
    // the operator explicitly choosing to SHOW the file, and hiding it is a
    // default this step provides, not a mandate it re-imposes every boot.
    //
    // The shared-skills root goes the OTHER way. An earlier release hid it
    // like `Plugins/`; the Skills & Tools sidebar now renders it as a file
    // tree read from the workspace tree, which the ignore file filters — so a
    // KB still carrying that rule would show an empty Skills section. The
    // line that release wrote comes out, recognised by the PLATFORM'S OWN
    // COMMENT above it — an operator who wrote the same rule by hand keeps
    // it, for the same reason the negation above is kept: the file is
    // theirs. The Knowledge explorer never rendered the root and still does
    // not. Spelled with the CONFIGURED root name, since a deployment may
    // have renamed it.
    //
    // The plugins root follows the skills root: the same sidebar now draws
    // it as a file tree too, so the rule that hid it since the first seed
    // comes out. That one has no comment to know it by — it was in the
    // template body from the start — so every line spelling it goes,
    // whoever wrote it (see `withoutIgnoreLine`). ONE read-modify-write for
    // all the rules: separate passes would each read the on-disk file and
    // a later declared write would lose an earlier one's.
    added.push(
      ...(await reconcileIgnoreRules(repoDir, branch, {
        add: ['AGENTS.md', PREAMBLE_IGNORE_PATTERN],
        drop: [`${SKILLS_DIR}/`],
        dropEvery: [`${PLUGINS_DIR}/`],
      })),
    );

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

/**
 * The template's content for `relPath`, RENDERED: the managed files name the
 * three root folders, and a deployment may have renamed those, so the
 * placeholders the template carries (`{{pluginsDir}}` …) are filled with the
 * names in effect. Every required file is text; a template without
 * placeholders passes through unchanged.
 */
async function readTemplate(templateDir: string, relPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(await templateSource(templateDir, relPath), 'utf8');
  } catch (err) {
    const packaged = defaultKbTemplateDir();
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || !PACKAGED_FALLBACK_FILES.has(relPath) || templateDir === packaged) {
      throw err;
    }
    console.warn(
      `[kb-startup] template-files: the configured KB template has no "${relPath}"; ` +
        'using the packaged copy. Add the file to the template to silence this.',
    );
    raw = await fs.readFile(await templateSource(packaged, relPath), 'utf8');
  }
  return renderKbLayoutPlaceholders(raw);
}

/**
 * Whether the repo's copy of `relPath` differs from the RENDERED template's,
 * modulo line endings — a CRLF checkout of identical content must read as
 * "same", or the managed-file refresh would commit churn on every boot
 * forever. Rendered, so a renamed root is compared against the guide that
 * names it, not against the placeholders.
 */
async function templateDiffers(templateDir: string, repoDir: string, relPath: string): Promise<boolean> {
  const norm = (text: string) => text.replace(/\r\n?/g, '\n');
  const [current, template] = await Promise.all([
    fs.readFile(path.join(repoDir, relPath), 'utf8'),
    readTemplate(templateDir, relPath),
  ]);
  return norm(current) !== norm(template);
}

/**
 * Reconcile the platform's OWN rules in `.bevelignore`: every `add` pattern
 * guaranteed present as a line, every `drop` pattern taken out. Returns the
 * paths changed, for the note.
 *
 * Never rewrites the rest. The file is the operator's, and every rule already
 * in it is theirs to keep: adding puts one line under a comment saying where
 * it came from, and dropping removes exactly the line (and the comment) an
 * earlier release put there — never a line the operator wrote. Absent file is
 * a no-op — it means the template's copy (declared in the same step, and
 * reconciled the same way at declaration) arrives with the right rules in it.
 *
 * Matched line-wise rather than by substring: a rule for `Plugins/AGENTS.md`
 * is not a rule for the root `AGENTS.md`, and treating it as one would leave
 * the mismatch this exists to close.
 */
async function reconcileIgnoreRules(
  repoDir: string,
  branch: KbBranch,
  rules: { add: string[]; drop: string[]; dropEvery?: string[] },
): Promise<string[]> {
  let current: string;
  try {
    current = await fs.readFile(path.join(repoDir, IGNORE_FILENAME), 'utf8');
  } catch {
    // No ignore file — the copy declared from the template arrives with the
    // right rules in it (guaranteed at declaration time, see the
    // required-files loop above).
    return [];
  }
  const added = rules.add.reduce((text, pattern) => withIgnorePattern(text, pattern), current);
  const merged = (rules.dropEvery ?? []).reduce(
    (text, pattern) => withoutIgnoreLine(text, pattern),
    rules.drop.reduce((text, pattern) => withoutPlatformIgnorePattern(text, pattern), added),
  );
  if (merged === current) return [];
  branch.write(IGNORE_FILENAME, merged);
  return [IGNORE_FILENAME];
}

/**
 * `text` without EVERY line that is exactly `pattern`, whoever wrote it, and
 * without a platform comment sitting directly above one. The other drop keeps
 * an operator's identical line; this one does not, and the difference is
 * deliberate: the plugins-root rule was in the template from the first seed
 * with no comment to know it by, so provenance cannot decide it — and the
 * Skills & Tools sidebar now renders that root as a file tree read from the
 * workspace tree, which the rule would empty. A `!pattern` negation is not
 * the pattern and stays. A platform comment directly above a dropped line
 * goes with it, and so does the blank line that opened an appended block —
 * the same tidy-up `withoutPlatformIgnorePattern` does, so a file either
 * step cleans reads the same afterwards.
 *
 * Exported for the Groups→Plugins step, which retires the same rules on the
 * branches this step never visits (drafts).
 */
export function withoutIgnoreLine(text: string, pattern: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (line.trim() !== pattern) {
      kept.push(line);
      continue;
    }
    const above = kept[kept.length - 1];
    if (above === undefined || !isPlatformRuleComment(above)) continue;
    kept.pop();
    if (above.trim() === PLATFORM_RULE_COMMENT && kept.length > 1 && kept[kept.length - 1]?.trim() === '') kept.pop();
  }
  return kept.join('\n');
}

/** The legacy comment `withIgnorePattern` wrote above AGENTS.md. */
const PLATFORM_RULE_COMMENT = '# Added by the platform: the conventions doc is not node content.';

/** The comment written above the preamble rule on an existing knowledge base. */
const PREAMBLE_RULE_COMMENT =
  '# Added by the platform: agent instructions are edited from External agent access.';

/**
 * The template line an earlier release shipped above the shared-skills rule,
 * split around its one variable: the plugins root's name, which a deployment
 * may have renamed since. Everything else is fixed.
 */
const LEGACY_SKILLS_RULE_COMMENT_OPENING = '# The shared-skills root is rendered by the Skills & Tools app, like ';
const LEGACY_SKILLS_RULE_COMMENT_CLOSING = '/.';

/**
 * Whether a line is EXACTLY a comment the platform wrote above a rule it
 * added. For the legacy template line that means the fixed opening, the
 * fixed closing, and between them a name the platform could have rendered
 * there — judged by the ONE rule that decides what a root may be called
 * (`validateKbRootName`), not by a second grammar written here: a hand-made
 * character class either admits names the validator refuses, or refuses
 * names it admits (a space, say), and either way a line the platform did
 * write would be left standing. A looser match (an opening, a substring)
 * errs the other way and takes a line the operator wrote.
 */
function isPlatformRuleComment(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === PLATFORM_RULE_COMMENT || trimmed === PREAMBLE_RULE_COMMENT) return true;
  if (
    !trimmed.startsWith(LEGACY_SKILLS_RULE_COMMENT_OPENING) ||
    !trimmed.endsWith(LEGACY_SKILLS_RULE_COMMENT_CLOSING)
  ) {
    return false;
  }
  const name = trimmed.slice(
    LEGACY_SKILLS_RULE_COMMENT_OPENING.length,
    trimmed.length - LEGACY_SKILLS_RULE_COMMENT_CLOSING.length,
  );
  return name === name.trim() && validateKbRootName(name) === null;
}

/**
 * `text` without the `pattern` lines THE PLATFORM WROTE — the ones sitting
 * directly under its own comment (the one `withIgnorePattern` writes, or the
 * template line an earlier release shipped) — and without that comment, plus
 * the blank line that opened an appended block. Provenance is the comment:
 * an identical line with no platform comment above it is the operator's and
 * stays, as does a `!pattern` negation. Nothing else moves.
 */
function withoutPlatformIgnorePattern(text: string, pattern: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const above = kept[kept.length - 1];
    if (line.trim() !== pattern || above === undefined || !isPlatformRuleComment(above)) {
      kept.push(line);
      continue;
    }
    kept.pop();
    if (above.trim() === PLATFORM_RULE_COMMENT && kept.length > 1 && kept[kept.length - 1]?.trim() === '') kept.pop();
  }
  return kept.join('\n');
}

/**
 * `text` with `pattern` guaranteed present as a LINE — appended under a
 * comment naming its origin when absent, returned unchanged when present.
 * Line-wise match, same rationale as {@link mergeIgnorePatterns}.
 *
 * An explicit `!pattern` line also returns the text unchanged: that is the
 * operator choosing to SHOW the file, and ordered matching means a positive
 * line appended after it would win and silently defeat the choice. Hiding
 * the conventions doc is a default this provides, never a mandate.
 */
function withIgnorePattern(text: string, pattern: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  const legacyPreambleChoice =
    pattern === PREAMBLE_IGNORE_PATTERN &&
    (lines.includes(PREAMBLE_FILE) || lines.includes(`!${PREAMBLE_FILE}`));
  if (lines.includes(pattern) || lines.includes(`!${pattern}`) || legacyPreambleChoice) return text;
  const separator = text.endsWith('\n') ? '' : '\n';
  const comment = pattern === PREAMBLE_IGNORE_PATTERN ? PREAMBLE_RULE_COMMENT : PLATFORM_RULE_COMMENT;
  return `${text}${separator}\n${comment}\n${pattern}\n`;
}
