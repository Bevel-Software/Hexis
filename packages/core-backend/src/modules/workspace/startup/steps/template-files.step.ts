import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LEGACY_AGENTS_FILE,
  validateKbRootName,
  type KbLayout,
} from '@bevel-software/platform-shared';
import { IGNORE_FILENAME, isAbsence, type IFsProbe } from '../../../../shared/fs.contract.js';
import type { KbContext } from '../../../../shared/kb-context.js';
import { PREAMBLE_FILE } from '../../../agent-instructions/compose.js';
import { isManagedGuide } from '../../../agent-guide/agent-guide.js';
import { TemplateSource } from './template-source.js';
import type { KbBranch, OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';
import { hasGitInternalsSegment } from '../../../../shared/git-internals.js';

export { isManagedGuide };

/** Root-anchored so a knowledge folder may still contain an ordinary namesake. */
const PREAMBLE_IGNORE_PATTERN = `/${PREAMBLE_FILE}`;

/**
 * The guide's name before it was `AGENTS.md`, back when it was a file. A copy
 * the platform wrote under it is taken out of the repository like one under
 * the current name (see {@link TemplateFilesStep.retireGuideCopies}).
 */
const PRE_RENAME_AGENTS_FILE = 'CLAUDE.md';

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
 * seeded with a stale hard-coded Admin list. The agent guide is in neither
 * either, any more: it is served from code (see modules/agent-guide), and the
 * copies earlier releases wrote are REMOVED here, not refreshed.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the list is a function of the layout to its callers, though no name in it is configurable today
export function requiredFiles(_layout: Required<KbLayout>): readonly string[] {
  return [
    'access.md',
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
 * A function of the layout: the three names are deployment-configurable, and
 * a module-scope array would snapshot the defaults before configuration.
 */
function coreRequiredDirs(layout: Required<KbLayout>): readonly string[] {
  return [layout.knowledgeBaseDir, layout.skillsDir, layout.pluginsDir];
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
  // The git folder can never be a KB root: writing `<dir>/.gitkeep` under it
  // would corrupt the clone's own metadata. In ANY spelling that names it —
  // any case, a trailing dot or space Windows collapses, a percent-encoded
  // form — the one rule every path check uses (`shared/git-internals.ts`).
  if (hasGitInternalsSegment(dir)) {
    throw new Error(`Reserved KB root must not name the git folder (".git" in any spelling); got "${dir}"`);
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
export function reservedRootDirs(extraRootDirs: readonly string[], layout: Required<KbLayout>): readonly string[] {
  for (const dir of extraRootDirs) {
    assertRootSegment(dir);
    // A root named after a required OR generated FILE is a typo with a silent
    // outcome: the file is laid down first, so the dir check finds the path
    // taken and skips it, and the directory the caller asked for never appears
    // with nothing said about why.
    if (requiredFiles(layout).includes(dir) || GENERATED_FILES.includes(dir)) {
      throw new Error(
        `Reserved KB root "${dir}" collides with a required or generated file of the same name`,
      );
    }
  }
  return [...coreRequiredDirs(layout), ...extraRootDirs];
}

/**
 * The template top-up as an {@link OnServerStart} step: add any missing base
 * scaffolding to every PROTECTED branch, and take the agent guide copies
 * earlier releases wrote OUT of them — the guide is served from code now, and
 * a copy left on disk would be read as the organisation's own conventions
 * file, stale and under a header that says the platform owns it. Drafts are
 * deliberately out of scope — whatever the protected branches gain, drafts
 * fork from; a scaffolding addition on a draft would surface as noise in its
 * change request's diff. (Unlike the Groups→Plugins rename, a missing file
 * diffs as one file, not the whole tree — so the uniform-application argument
 * does not bite here. A stale guide copy on a draft is recognised by its
 * header and never served, see `modules/agent-guide`.)
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
  constructor(
    private readonly disk: IFsProbe,
    /**
     * Read per run, never captured: the save that completes first-run setup
     * applies the admin's names after this step was built. A snapshot taken
     * here scaffolded `Skills/` beside the `skills/` they had just chosen.
     */
    private readonly kb: Pick<KbContext, 'layout'>,
    private readonly extraRootDirs: readonly string[] = [],
  ) {
    // Validated NOW, so a bad extra fails at boot beside the rest of the
    // wiring — but the list itself is NOT kept, for the reason `kb` says.
    reservedRootDirs(extraRootDirs, kb.layout);
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
    const templates = new TemplateSource(this.disk, templateDir, this.kb);
    const repoDir = await branch.repoDir();
    const added: string[] = [];
    // Read ONCE per branch: a value re-read between the write and the ignore
    // rule could disagree with itself.
    const layout = this.kb.layout;

    for (const rel of requiredFiles(layout)) {
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
      let content = await templates.read(rel);
      // The on-disk merge below only runs against an EXISTING ignore file; a
      // freshly-declared one is reconciled here instead, so a distribution's
      // custom template that predates a rule — or still ships one an earlier
      // release had — declares the same file the merge would have produced.
      // The deployment preamble is edited through External agent access, not
      // as an ordinary knowledge-base document, so its rule is guaranteed;
      // the rules that hid the skills root, the plugins root and the guide
      // copies the platform used to write are taken out (see the merge below
      // for why each).
      if (rel === IGNORE_FILENAME) {
        // A template still shipping the unanchored preamble rule an earlier
        // release had is respelled first, so the guarantee below adds nothing
        // beside it.
        content = withPlatformIgnorePatternRespelled(content, PREAMBLE_FILE, PREAMBLE_IGNORE_PATTERN);
        content = withoutPlatformGuideRules(
          withoutIgnoreLine(
            withoutPlatformIgnorePattern(
              withIgnorePattern(content, PREAMBLE_IGNORE_PATTERN),
              `${layout.skillsDir}/`,
            ),
            `${layout.pluginsDir}/`,
          ),
          [LEGACY_AGENTS_FILE, PRE_RENAME_AGENTS_FILE],
        );
      }
      branch.write(rel, content);
      added.push(rel);
    }

    // mcp-description.md left VISIBLE by a stale `.bevelignore` is closed
    // here — and UNCONDITIONALLY, not only when the file was just added.
    // Idempotent: an ignore file already carrying the rule — or absent, in
    // which case the template's copy declared above arrives with the rule in
    // it — changes nothing and produces no note. Deliberately checked by
    // LINE PRESENCE, not effective outcome: a later `!/mcp-description.md`
    // negation is the operator explicitly choosing to SHOW the file, and
    // hiding it is a default this step provides, not a mandate it re-imposes
    // every boot.
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
    // whoever wrote it (see `withoutIgnoreLine`).
    //
    // And the guide's rules go the same way as the skills root's. Every
    // release that wrote the guide to disk hid it with a rule of its own —
    // under `AGENTS.md`, under the name a deployment gave the guide (any
    // name it ever gave it: the copies found at the root say which), and
    // under `CLAUDE.md` for the copy that predates the rename. The guide is
    // not on disk any more, so a root file under any of those names is the
    // organisation's own conventions page, which they must be able to see
    // and edit in the app. The platform's own lines come out, recognised by
    // the comment or the template slot each release wrote them in (see
    // {@link withoutPlatformGuideRules}); a rule an operator wrote by hand
    // is theirs and stays. ONE read-modify-write for all the rules: separate
    // passes would each read the on-disk file and a later declared write
    // would lose an earlier one's.
    //
    // The copies come out first only so the one commit this step makes can
    // name them in its subject; the rule pass below does not read the names
    // — a guide rule is known by the platform's comment above it, whatever
    // name it spells.
    const retired = await this.retireGuideCopies(repoDir, branch);
    added.push(...retired);
    added.push(
      ...(await this.reconcileIgnoreRules(repoDir, branch, {
        // The preamble rule is respelled before it is added: a knowledge base
        // that booted the release shipping the unanchored spelling carries the
        // platform's own line, and that line hides a nested namesake too.
        respell: [[PREAMBLE_FILE, PREAMBLE_IGNORE_PATTERN]],
        add: [PREAMBLE_IGNORE_PATTERN],
        drop: [`${this.kb.layout.skillsDir}/`],
        dropEvery: [`${this.kb.layout.pluginsDir}/`],
        // The two names the template itself shipped a rule for. A rule under
        // any other name — a retired copy's, or a name no copy is left to
        // tell — is known by the platform's comment above it instead.
        guideNames: [LEGACY_AGENTS_FILE, PRE_RENAME_AGENTS_FILE],
      })),
    );

    added.push(...this.ensureRequiredDirs(repoDir, branch, await this.missingDirs(repoDir)));

    if (added.length === 0) return;
    // One honest line; it becomes the commit subject when this step is the
    // first to dirty the branch.
    const others = added.filter((rel) => !retired.includes(rel));
    branch.note(
      retired.length > 0
        ? `Remove the platform-written ${retired.join(' and ')} — the agent guide is served by the platform now` +
            (others.length > 0 ? `; update ${others.join(', ')}` : '')
        : `Add missing KB scaffolding: ${added.join(', ')}`,
    );
  }

  /**
   * The copies of the guide the platform wrote to the repository root while
   * the guide was a file — under `AGENTS.md`, under `CLAUDE.md` from before
   * the rename, and under every name a deployment ever gave the guide —
   * removed when the platform can PROVE it wrote them, and otherwise left
   * exactly alone.
   *
   * Found by SCANNING the root's markdown files rather than by the names the
   * deployment knows today: a deployment that renamed the guide more than
   * once left a copy under each earlier name, and the current setting
   * remembers only the last. The header is what makes a scan safe, and the
   * one fact that tells a copy of ours from a file of theirs: the
   * organisation's own `AGENTS.md`, a `CLAUDE.md` its people edited, a note
   * of theirs that happens to sit at the root, must all be found byte for
   * byte untouched. A SYMLINK or a directory is left as it is: reading a link
   * follows it, so a link pointing at a copy of the guide — or at any other
   * file carrying the header — would read as ours and the removal would take
   * the organisation's entry. Links are never followed anywhere else in the
   * platform, and they are not followed here.
   *
   * Returns the names removed, in name order, for the note and for the
   * ignore rules that hid them.
   */
  private async retireGuideCopies(repoDir: string, branch: KbBranch): Promise<string[]> {
    const removed: string[] = [];
    const entries = await fs.readdir(repoDir, { withFileTypes: true });
    // `isFile` is false for a link, which is the point (see above).
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
    for (const name of candidates) {
      let current: string;
      try {
        current = await this.disk.readTextFile(path.join(repoDir, name));
      } catch (err) {
        // Gone between the listing and the read — a concurrent delete reads
        // as the absence it is.
        if (isAbsence(err)) continue;
        throw err;
      }
      if (!isManagedGuide(current)) continue;
      branch.remove(name);
      removed.push(name);
    }
    return removed;
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
    for (const rootDir of reservedRootDirs(this.extraRootDirs, this.kb.layout)) {
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
      /** The names the template itself shipped a guide rule for; a rule under any other name is known by its comment (see {@link withoutPlatformGuideRules}). */
      guideNames: readonly string[];
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
    const merged = withoutPlatformGuideRules(dropped, rules.guideNames);
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
 * `text` without the rules THE PLATFORM WROTE to hide the guide while it was a
 * file. Under WHATEVER name: every rule sitting directly under one of the two
 * comments the platform wrote above the guide's rule
 * ({@link withoutPlatformConventionsRules}) — the name a deployment saved for
 * the guide is not read any more, so the rule for it is known by its comment
 * and by nothing else. Then the two names the template itself shipped a rule
 * for, under each of `names`: the `AGENTS.md` line in the slot at the end of
 * the template's own repo-hygiene block
 * ({@link TEMPLATE_HYGIENE_BLOCK_ABOVE_AGENTS_RULE}) and the `CLAUDE.md` line
 * under the two-line comment the template carried it with. Each goes with
 * its comment.
 *
 * The guide is not on disk any more, which is what makes every one of these
 * lines wrong: it hides a file the platform never writes, which is therefore
 * the organisation's own. A `!AGENTS.md` negation is not the rule and stays,
 * as everywhere else here, and so does a bare rule an operator wrote by hand.
 */
export function withoutPlatformGuideRules(text: string, names: readonly string[]): string {
  let out = withoutPlatformConventionsRules(text);
  for (const name of new Set(names)) {
    if (name === LEGACY_AGENTS_FILE) out = withoutPlatformAgentsRule(out);
    else if (name === PRE_RENAME_AGENTS_FILE) out = withoutPlatformClaudeRule(out);
  }
  return out;
}

/**
 * `text` without every rule line that sits DIRECTLY under one of the two
 * comments the platform wrote above the guide's rule while the guide was a
 * file ({@link PLATFORM_RULE_COMMENT}, {@link AGENTS_RULE_COMMENT}), whatever
 * name the rule spells — `AGENTS.md`, `CLAUDE.md`, or the escaped form of a
 * name a deployment chose — and without that comment, plus the blank line
 * that opened the appended block. Those two comments were written above
 * nothing else, so the comment is the whole provenance: a rule for a name
 * nobody remembers is retired exactly like one for a name still known. A
 * `!negation`, a blank or a further comment under the comment is not a rule
 * and stays, comment included.
 */
function withoutPlatformConventionsRules(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const above = kept[kept.length - 1]?.trim();
    const rule = line.trim();
    const ours =
      (above === PLATFORM_RULE_COMMENT || above === AGENTS_RULE_COMMENT) &&
      rule !== '' &&
      !rule.startsWith('#') &&
      !rule.startsWith('!');
    if (!ours) {
      kept.push(line);
      continue;
    }
    kept.pop();
    if (kept.length > 1 && kept[kept.length - 1]?.trim() === '') kept.pop();
  }
  return kept.join('\n');
}

/** The two comment lines the packaged template carried above its `CLAUDE.md` rule, in order. */
const TEMPLATE_CLAUDE_RULE_COMMENT: readonly string[] = [
  '# The pre-rename name. Listed so a knowledge base carrying both files hides',
  '# both — top-up adds AGENTS.md but never deletes the CLAUDE.md beside it.',
];

/**
 * `text` without the `CLAUDE.md` line the packaged template wrote, and without
 * the two comment lines it wrote above it. Provenance is that comment, as
 * everywhere else here: a bare `CLAUDE.md` an operator wrote is theirs.
 */
function withoutPlatformClaudeRule(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const [first, second] = TEMPLATE_CLAUDE_RULE_COMMENT;
    const ours =
      line.trim() === PRE_RENAME_AGENTS_FILE &&
      kept.length >= 2 &&
      kept[kept.length - 1]!.trim() === second &&
      kept[kept.length - 2]!.trim() === first;
    if (!ours) {
      kept.push(line);
      continue;
    }
    kept.splice(-2, 2);
  }
  return kept.join('\n');
}

/**
 * `text` without the `AGENTS.md` line THE PLATFORM WROTE — under its own
 * comment (either spelling), or in the slot at the end of the template's own
 * repo-hygiene block ({@link TEMPLATE_HYGIENE_BLOCK_ABOVE_AGENTS_RULE}) — and
 * without that comment. A `!AGENTS.md` negation is not the rule and stays, as
 * everywhere else here.
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
  const comment = pattern === PREAMBLE_IGNORE_PATTERN ? PREAMBLE_RULE_COMMENT : PLATFORM_RULE_COMMENT;
  return `${text}${separator}\n${comment}\n${pattern}\n`;
}
