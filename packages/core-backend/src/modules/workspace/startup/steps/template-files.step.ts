import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AGENTS_FILE,
  KNOWLEDGE_BASE_DIR,
  LEGACY_AGENTS_FILE,
  PLUGINS_DIR,
  SKILLS_DIR,
  agentsFilePointerSentence,
  validateKbRootName,
} from '@bevel-software/platform-shared';
import { IGNORE_FILENAME, isAbsence, type IFsProbe } from '../../../../shared/fs.contract.js';
import { PREAMBLE_FILE } from '../../../agent-instructions/compose.js';
import { TemplateSource } from './template-source.js';
import type { KbBranch, OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';
import { hasGitInternalsSegment } from '../../../../shared/git-internals.js';

/** Root-anchored so a knowledge folder may still contain an ordinary namesake. */
const PREAMBLE_IGNORE_PATTERN = `/${PREAMBLE_FILE}`;

/**
 * The **required scaffolding** — the minimum an operational KB needs. Any of
 * these missing from a protected branch are added at the startup phase; the
 * sample ontology is NOT (it only seeds a fully-empty repo, see seed-tree.ts).
 *
 * Two kinds:
 *  - {@link requiredFiles}: repo-root files added when the file is missing.
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
export function requiredFiles(): readonly string[] {
  return [
    'access.md',
    // The managed agent guide, under whatever this deployment calls it. The
    // PACKAGED template still carries it as `AGENTS.md` — one file, one
    // spelling in the tarball — so the write target and the template source
    // part company here and nowhere else (see {@link templateNameOf}).
    AGENTS_FILE,
    '.bevelignore',
    '.gitignore',
    // The deployment preamble every connected agent is told at session start
    // (see modules/agent-instructions). Seeded ONCE and never refreshed: the
    // content is the admin's, and the shipped template is one HTML comment, so
    // a never-edited file sends nothing of its own.
    PREAMBLE_FILE,
  ];
}

/**
 * The template's own name for a required file. The guide is the one file whose
 * name on disk is a deployment's choice while its name in the template is
 * fixed; everything else is spelled the same on both sides.
 */
function templateNameOf(repoRel: string): string {
  return repoRel === AGENTS_FILE ? LEGACY_AGENTS_FILE : repoRel;
}

/**
 * The sentence the managed guide carries about itself, and the ONLY thing that
 * makes a root `AGENTS.md` provably the platform's rather than the customer's.
 *
 * Matched on this one phrase rather than on the whole header: the lines around
 * it have changed between releases (they name the configured file now), and a
 * knowledge base seeded by any of those releases is still ours to remove. A
 * customer file would have to quote the platform's own claim about itself
 * verbatim to be mistaken for one, and the consequence of the mistake is a
 * deletion — which is why nothing looser will do.
 */
const MANAGED_GUIDE_MARKER = '**This file is managed by the platform.**';

/** Whether `text` is a copy of the platform's managed guide, of any vintage. */
export function isManagedGuide(text: string): boolean {
  return text.includes(MANAGED_GUIDE_MARKER);
}

/**
 * Repo-root files the startup phase GENERATES rather than copies — today just
 * `roles.yaml`, rendered from `ADMIN_EMAIL` (see roles-yaml.step.ts and
 * seed-tree.ts). Reserved-root validation must treat these exactly like
 * {@link requiredFiles}: a root claiming a generated name is the same silent
 * typo with the same silent outcome.
 */
export const GENERATED_FILES: readonly string[] = ['roles.yaml'];

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
  if (hasGitInternalsSegment(dir)) {
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
    if (requiredFiles().includes(dir) || GENERATED_FILES.includes(dir)) {
      throw new Error(
        `Reserved KB root "${dir}" collides with a required or generated file of the same name`,
      );
    }
  }
  return [...coreRequiredDirs(), ...extraRootDirs];
}

/**
 * The template top-up as an {@link OnServerStart} step: add any missing base
 * scaffolding to every PROTECTED branch, and keep the managed agent guide
 * current — under whatever this deployment calls it, and taking its own
 * stale `AGENTS.md` with it when that name was handed back to the customer. Drafts are deliberately out of scope — whatever the protected
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

  /**
   * @param extraRootDirs Additional root folders this distribution reserves,
   *                      on top of core's two. Their `.gitkeep` is written
   *                      directly rather than copied, so a distribution can
   *                      claim a root without also shipping a template entry
   *                      for it.
   */
  /**
   * @param agentsFileLink Whether to keep the platform's pointer sentence in a
   *                       customer-owned root `AGENTS.md` — a GETTER, because
   *                       the setting behind it may be saved by the very
   *                       first-run save that then runs this phase.
   */
  constructor(
    private readonly disk: IFsProbe,
    private readonly extraRootDirs: readonly string[] = [],
    private readonly agentsFileLink: () => boolean = () => true,
  ) {
    // Validated NOW, so a bad extra fails at boot beside the rest of the
    // wiring — but the list itself is NOT kept: the core roots are live
    // bindings, and the save that completes first-run setup applies the
    // admin's names after this step was built. A snapshot taken here
    // scaffolded `Skills/` beside the `skills/` they had just chosen.
    reservedRootDirs(extraRootDirs);
  }

  async run(ctx: ServerStartContext): Promise<StepResult> {
    for (const branch of await ctx.protectedBranches()) {
      await this.topUp(ctx.templateDir, branch);
    }
    return { outcome: 'ok' };
  }

  private async topUp(templateDir: string, branch: KbBranch): Promise<void> {
    // The template directory is runtime data (the start context's), the disk
    // port is the injected dependency — bound together once here so nothing
    // below has to carry either as an argument.
    const templates = new TemplateSource(this.disk, templateDir);
    const repoDir = await branch.repoDir();
    const added: string[] = [];
    // Read ONCE per branch: the name is a live binding, and a value re-read
    // between the write and the ignore rule could disagree with itself.
    const agentsFile = AGENTS_FILE;
    const renamed = agentsFile !== LEGACY_AGENTS_FILE;

    for (const rel of requiredFiles()) {
      // `lstat`, not `exists`: a DIRECTORY or SYMLINK squatting a required
      // file's name would read as "present", and a skip-if-present check
      // would then report success over a knowledge base whose root access
      // policy (say) cannot be read. Fail-closed, same as the reserved-root
      // squatting check below: this is a state a human must fix.
      const found = await this.disk.lstatOrNull(path.join(repoDir, rel));
      if (found) {
        if (found.isFile()) continue;
        throw new Error(
          `Required KB file "${rel}" on branch "${branch.name}" exists but is not a regular file ` +
            `(${found.isSymbolicLink() ? 'symlink' : found.isDirectory() ? 'directory' : 'special file'}). ` +
            'Remove or rename it — the platform requires this name to be a readable file.',
        );
      }
      let content = await templates.read(templateNameOf(rel));
      // The on-disk merge below only runs against an EXISTING ignore file; a
      // freshly-declared one was merely assumed to carry the guide's rule —
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
        // A template still shipping the unanchored preamble rule an earlier
        // release had is respelled first, so the guarantee below adds nothing
        // beside it.
        content = withPlatformIgnorePatternRespelled(content, PREAMBLE_FILE, PREAMBLE_IGNORE_PATTERN);
        content = withoutIgnoreLine(
          withoutPlatformIgnorePattern(
            withIgnorePattern(withIgnorePattern(content, agentsFile), PREAMBLE_IGNORE_PATTERN),
            `${SKILLS_DIR}/`,
          ),
          `${PLUGINS_DIR}/`,
        );
        // …and a template (a distribution's, a stale packaged one) still
        // hiding `AGENTS.md` while this deployment's guide is called something
        // else would hide the CUSTOMER'S file from the first boot — the exact
        // thing the rename exists to prevent.
        if (renamed) content = withoutPlatformAgentsRule(content);
      }
      branch.write(rel, content);
      added.push(rel);
    }

    // The guide or mcp-description.md left VISIBLE by a stale `.bevelignore`
    // is closed here — and
    // UNCONDITIONALLY, not only when the file was just added: a KB whose
    // guide predates the CLAUDE.md→AGENTS.md rename has an ignore file
    // that lists the old name and knows nothing of the new one, so the
    // conventions doc shows up in the file tree and the agent view. A KB
    // whose deployment has just RENAMED the guide is the same story one
    // rename later: the rule names a file that is now the customer's.
    // Idempotent: an ignore file already carrying the rule — or absent, in
    // which case the template's copy declared above arrives with the rule in
    // it — changes nothing and produces no note. Deliberately checked by
    // LINE PRESENCE, not effective outcome: a later `!<guide>` negation is
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
      ...(await this.reconcileIgnoreRules(repoDir, branch, {
        // The preamble rule is respelled before it is added: a knowledge base
        // that booted the release shipping the unanchored spelling carries the
        // platform's own line, and that line hides a nested namesake too.
        respell: [[PREAMBLE_FILE, PREAMBLE_IGNORE_PATTERN]],
        add: [agentsFile, PREAMBLE_IGNORE_PATTERN],
        drop: [`${SKILLS_DIR}/`],
        dropEvery: [`${PLUGINS_DIR}/`],
        // The guide's rule FOLLOWS its name. Once the guide is `HEXIS.md`, the
        // root's `AGENTS.md` is the customer's own conventions file and they
        // must be able to see and edit it in the app — so the platform's own
        // line comes out, recognised the way the skills-root line was
        // (see {@link withoutPlatformAgentsRule}); a rule an operator wrote by
        // hand is theirs and stays.
        dropAgentsRule: renamed,
      })),
    );

    // The guide is MANAGED, not merely seeded: the platform owns its content,
    // and a stale copy is replaced with the packaged template's every startup
    // phase. The file's own header says so, which is what makes overwriting
    // edits a stated contract instead of a surprise.
    let agentsRefreshed = false;
    if (
      !added.includes(agentsFile) &&
      (await templates.differsFrom(repoDir, agentsFile, LEGACY_AGENTS_FILE))
    ) {
      branch.write(agentsFile, await templates.read(LEGACY_AGENTS_FILE));
      added.push(agentsFile);
      agentsRefreshed = true;
    }

    // What becomes of the `AGENTS.md` the platform used to own, now that the
    // guide lives somewhere else. Nothing at all while the name is the default.
    if (renamed) {
      added.push(
        ...(await this.reconcileLegacyGuide(repoDir, branch, {
          agentsFile,
          // Only on the boot the rename lands — the boot that first writes the
          // guide under its new name. Said every boot after, the "kept" note
          // would caption commits about other things forever.
          announceKept: added.includes(agentsFile),
        })),
      );
    }

    added.push(...this.ensureRequiredDirs(repoDir, branch, await this.missingDirs(repoDir)));

    if (added.length === 0) return;
    // One honest line; it becomes the commit subject when this step is the
    // first to dirty the branch.
    branch.note(
      agentsRefreshed && added.length === 1
        ? `Update ${agentsFile} to the current platform template`
        : `Add missing KB scaffolding: ${added.join(', ')}`,
    );
  }

  /**
   * The root `AGENTS.md` on a deployment whose guide is called something else:
   * removed when the platform can PROVE it wrote it, otherwise left alone —
   * and, while the admin keeps the link setting on, given the one sentence
   * that points at the guide beside it.
   *
   * Removal is gated on the managed header and nothing else. An admin who
   * renames the guide on a knowledge base the platform seeded would otherwise
   * be left with stale platform content sitting under the very name they
   * wanted for their own file; an admin who renames it on a repository whose
   * `AGENTS.md` is their own must find that file byte-for-byte untouched. The
   * header is the one fact that tells the two apart, so it is the one thing
   * asked.
   *
   * The pointer is bounded by three conditions, all of them the customer's to
   * control: the admin keeps the setting on, the file exists (one is NEVER
   * created for this), and the guide's name appears nowhere in the text. That
   * last one is a plain content search on purpose — a mention in the
   * customer's own words, a link, a heading, all count, and the platform stays
   * out of a file it does not own.
   *
   * Returns the paths changed, for the note.
   */
  private async reconcileLegacyGuide(
    repoDir: string,
    branch: KbBranch,
    opts: { agentsFile: string; announceKept: boolean },
  ): Promise<string[]> {
    const legacyPath = path.join(repoDir, LEGACY_AGENTS_FILE);
    // `lstat` first, and a REGULAR FILE or nothing at all.
    //
    // Nothing there is the ordinary case: no customer file means nothing to
    // remove and nothing to point at the guide — the platform never creates an
    // `AGENTS.md` for this.
    //
    // Anything that is not a plain file is left exactly as it is. A SYMLINK is
    // the case that matters: reading one follows it, so a link pointing at a
    // knowledge base's managed guide — or at any other file carrying the
    // header — would read as "ours" and the removal would take the customer's
    // entry; writing one follows it too, and the pointer sentence would land
    // in a file at the other end that nobody asked us to edit. Links are never
    // followed anywhere else in the platform, and they are not followed here.
    // A directory under the name is the same answer for the same reason.
    const found = await this.disk.lstatOrNull(legacyPath);
    if (found === null || !found.isFile()) return [];

    let current: string;
    try {
      current = await this.disk.readTextFile(legacyPath);
    } catch (err) {
      // Gone between the probe and the read — a concurrent delete reads as the
      // absence it is, on the same terms as the probe above.
      if (isAbsence(err)) return [];
      throw err;
    }

    if (isManagedGuide(current)) {
      branch.remove(LEGACY_AGENTS_FILE);
      branch.note(`Remove the platform-written AGENTS.md — the agent guide is now ${opts.agentsFile}`);
      return [LEGACY_AGENTS_FILE];
    }

    if (opts.announceKept) {
      branch.note('Keep AGENTS.md — it is not a platform template, so it is the knowledge base\'s own');
    }
    if (!this.agentsFileLink() || current.includes(opts.agentsFile)) return [];
    branch.write(LEGACY_AGENTS_FILE, withPointerSentence(current, opts.agentsFile));
    branch.note(`Add a pointer to ${opts.agentsFile} at the end of AGENTS.md`);
    return [LEGACY_AGENTS_FILE];
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
    for (const rootDir of reservedRootDirs(this.extraRootDirs)) {
      const found = await this.disk.lstatOrNull(path.join(repoDir, rootDir));
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

  /**
   * Reconcile the platform's OWN rules in `.bevelignore`: every `respell` pair
   * rewritten in place, every `add` pattern guaranteed present as a line, every
   * `drop` pattern taken out. Returns the paths changed, for the note.
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
  private async reconcileIgnoreRules(
    repoDir: string,
    branch: KbBranch,
    rules: {
      add: string[];
      drop: string[];
      dropEvery?: string[];
      /** `[from, to]` pairs: a rule an earlier release wrote, and its spelling now. */
      respell?: ReadonlyArray<readonly [string, string]>;
      /** Take out the platform's own `AGENTS.md` line — the guide is called something else now. */
      dropAgentsRule?: boolean;
    },
  ): Promise<string[]> {
    let current: string;
    try {
      current = await fs.readFile(path.join(repoDir, IGNORE_FILENAME), 'utf8');
    } catch (err) {
      // No ignore file — the copy declared from the template arrives with the
      // right rules in it (guaranteed at declaration time, see the
      // required-files loop above). A file that is there but cannot be read is
      // NOT "no file": its rules may still be hiding the tree, so the hole is
      // the step's failure, as it is for the migration's retirement.
      if (!isAbsence(err)) throw err;
      return [];
    }
    const respelled = (rules.respell ?? []).reduce(
      (text, [from, to]) => withPlatformIgnorePatternRespelled(text, from, to),
      current,
    );
    const added = rules.add.reduce((text, pattern) => withIgnorePattern(text, pattern), respelled);
    const dropped = (rules.dropEvery ?? []).reduce(
      (text, pattern) => withoutIgnoreLine(text, pattern),
      rules.drop.reduce((text, pattern) => withoutPlatformIgnorePattern(text, pattern), added),
    );
    const merged = rules.dropAgentsRule ? withoutPlatformAgentsRule(dropped) : dropped;
    if (merged === current) return [];
    branch.write(IGNORE_FILENAME, merged);
    return [IGNORE_FILENAME];
  }
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

/** The legacy comment `withIgnorePattern` wrote above the guide's rule. */
const PLATFORM_RULE_COMMENT = '# Added by the platform: the conventions doc is not node content.';

/** The comment the packaged template carries above the guide's rule. */
const AGENTS_RULE_COMMENT = "# The platform's agent guide.";

/**
 * The repo-hygiene BLOCK of the packaged `.bevelignore`, exactly as every
 * release that shipped a bare guide rule wrote it, in order, ending at the
 * line that has always sat directly above that rule.
 *
 * It stands in for a comment on knowledge bases seeded before there was one.
 * The guide's rule shipped in the template body from the first seed, bare,
 * like the plugins-root rule did — but unlike that one it must not be dropped
 * wholesale, because an operator who writes `AGENTS.md` into their own ignore
 * file is saying something the platform has no business overruling.
 *
 * So provenance is the block the template put it in, and the WHOLE block is
 * asked for. The single line above it is not enough: `.gitattributes` is an
 * entry anyone might list, and a hand-written file that happens to name
 * `AGENTS.md` under it would have had its rule read as the platform's and
 * deleted. Three lines in the template's own order and wording are not
 * something an operator arrives at by coincidence — and a file that does
 * carry them carries the platform's block, however it got there.
 */
const TEMPLATE_HYGIENE_BLOCK_ABOVE_AGENTS_RULE: readonly string[] = [
  '# Repo hygiene files that clutter the tree without being node content.',
  '.gitignore',
  '.gitattributes',
];

/** Whether the lines kept so far END with that block — i.e. the next line is the slot. */
function followsTemplateHygieneBlock(kept: readonly string[]): boolean {
  const block = TEMPLATE_HYGIENE_BLOCK_ABOVE_AGENTS_RULE;
  if (kept.length < block.length) return false;
  return kept.slice(-block.length).every((line, i) => line.trim() === block[i]);
}

/**
 * `text` without the `AGENTS.md` line THE PLATFORM WROTE — under its own
 * comment (either spelling), or in the slot at the end of the template's own
 * repo-hygiene block ({@link TEMPLATE_HYGIENE_BLOCK_ABOVE_AGENTS_RULE}) — and
 * without that comment.
 *
 * Called only when the guide has been renamed, which is what makes the line
 * wrong: it hides a file the platform no longer owns. A `!AGENTS.md` negation
 * is not the rule and stays, as everywhere else here.
 */
export function withoutPlatformAgentsRule(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const above = kept[kept.length - 1];
    const ours =
      line.trim() === LEGACY_AGENTS_FILE &&
      above !== undefined &&
      (isPlatformRuleComment(above) || followsTemplateHygieneBlock(kept));
    if (!ours) {
      kept.push(line);
      continue;
    }
    // The hygiene block above the rule is content, not a marker: those lines
    // hide `.gitignore` and `.gitattributes` and stay. Only a comment the
    // platform wrote goes with the rule it introduced.
    if (!isPlatformRuleComment(above)) continue;
    kept.pop();
    // The blank line that opened an appended block goes with it; the template's
    // own comment sits inline, with content above it, and nothing to tidy.
    const appended = above.trim() === PLATFORM_RULE_COMMENT || above.trim() === AGENTS_RULE_COMMENT;
    if (appended && kept.length > 1 && kept[kept.length - 1]?.trim() === '') kept.pop();
  }
  return kept.join('\n');
}

/**
 * `text` with the platform's pointer sentence appended as its own paragraph.
 *
 * One blank line between the customer's last line and ours, whether or not
 * their file ended in a newline: a sentence glued onto the end of their last
 * paragraph would read as a continuation of something they wrote.
 */
export function withPointerSentence(text: string, agentsFile: string): string {
  const body = text.replace(/\n+$/, '');
  return `${body}\n\n${agentsFilePointerSentence(agentsFile)}\n`;
}

/** The comment written above the preamble rule on an existing knowledge base. */
const PREAMBLE_RULE_COMMENT =
  '# Added by the platform: agent instructions are edited from External agent access.';

/**
 * The line an earlier release shipped in the template above the UNANCHORED
 * preamble rule. Recognised as the platform's own, on the same reasoning as
 * the legacy skills line below: a rule under a comment the platform wrote is
 * the platform's to respell, wherever the file came from.
 */
const LEGACY_PREAMBLE_TEMPLATE_COMMENT =
  '# The deployment preamble is edited from External agent access, not as a KB page.';

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
  if (
    trimmed === PLATFORM_RULE_COMMENT ||
    trimmed === AGENTS_RULE_COMMENT ||
    trimmed === PREAMBLE_RULE_COMMENT ||
    trimmed === LEGACY_PREAMBLE_TEMPLATE_COMMENT
  ) {
    return true;
  }
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
 * `text` with every `from` line THE PLATFORM WROTE respelled as `to`, its
 * comment left where it is. Provenance is that comment, as everywhere else
 * here: a bare rule the OPERATOR wrote is theirs and is not touched.
 *
 * This exists for one migration. An earlier release hid the preamble with the
 * unanchored `mcp-description.md`, which also hides an ordinary knowledge
 * page of that name anywhere in the tree; the rule the platform means is the
 * root-anchored one. Respelling its own line is not the same as overruling an
 * operator who chose the broad spelling, which is why the two are told apart.
 */
function withPlatformIgnorePatternRespelled(text: string, from: string, to: string): string {
  const lines = text.split('\n');
  return lines
    .map((line, i) => {
      if (line.trim() !== from) return line;
      const above = lines[i - 1];
      if (above === undefined || !isPlatformRuleComment(above)) return line;
      // Function replacement: `to` is a pattern to `String.replace`, and a
      // rule spelled with a `$` would otherwise be read as one.
      return line.replace(from, () => to);
    })
    .join('\n');
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
 *
 * The preamble rule reads its unanchored spelling the same way. By the time
 * this runs, the platform's OWN legacy line has been respelled (see
 * {@link withPlatformIgnorePatternRespelled}), so a bare `mcp-description.md`
 * still standing here is the operator's: it already hides the file, and
 * appending the anchored rule beside it would say nothing they have not.
 */
function withIgnorePattern(text: string, pattern: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  const operatorPreambleRule =
    pattern === PREAMBLE_IGNORE_PATTERN &&
    (lines.includes(PREAMBLE_FILE) || lines.includes(`!${PREAMBLE_FILE}`));
  if (lines.includes(pattern) || lines.includes(`!${pattern}`) || operatorPreambleRule) return text;
  const separator = text.endsWith('\n') ? '' : '\n';
  const comment =
    pattern === PREAMBLE_IGNORE_PATTERN
      ? PREAMBLE_RULE_COMMENT
      : pattern === AGENTS_FILE
        ? AGENTS_RULE_COMMENT
        : PLATFORM_RULE_COMMENT;
  return `${text}${separator}\n${comment}\n${pattern}\n`;
}
