/**
 * Pre-disk placement gate for `SKILL.md`.
 *
 * WHY this exists: a skill is found by WHERE it sits, and nothing used to check
 * that. `SKILL.md` appeared only in read-side code — the catalog scanner, the
 * pending-skill shelf, the `Groups/`→`Plugins/` migration — so a `SKILL.md`
 * written anywhere else passed every write gate, committed, pushed, and
 * reported success while being ignored by the entire product. No warning when
 * it was proposed, none when it merged, no trace in the Library. The file was
 * real and the skill did not exist.
 *
 * That is not hypothetical: a change request adding `Skills/example/SKILL.md`
 * was correct when it was written, went stale while `main` migrated
 * `Skills/` → `Groups/` → `Plugins/`, and would today merge cleanly and change
 * nothing. Silent, unrecoverable-by-looking, and indistinguishable from a
 * product that simply did not notice.
 *
 * The gate is deliberately about PLACEMENT ONLY — the one property that decides
 * whether a skill exists at all. Frontmatter quality, a missing description, a
 * duplicate id: all real, all recoverable by editing a file the product can
 * already see. A misplaced file is the only failure that leaves nothing behind
 * to fix.
 *
 * Mirrors {@link makeRolesYamlWriteValidator} in shape and wiring on purpose.
 * One rule, one definition (`isSkillDocPath` in `kb-layout.ts`), applied at
 * every path that CREATES a file: the agent's filesystem hooks, the editor's
 * save and upload routes, and the per-entry guard both unzip callers pass.
 */

import { PLUGINS_DIR, SKILL_DOC_FILE, isSkillDocPath } from '@bevel-software/platform-shared';
import { WorkflowDomainError } from '../../shared/domain-errors.js';

/**
 * A write that would put a `SKILL.md` where no skill can be found. 422 (bad
 * input) — the write is refused and nothing lands. The message names the shape
 * that works, because the whole point of this gate is to replace a silent
 * no-op with an instruction.
 */
export class SkillPlacementError extends WorkflowDomainError {
  constructor(readonly repoRelativePath: string) {
    super(
      `"${repoRelativePath}" is not a place a skill can live, so it was not saved. ` +
        `A skill is a folder under ${PLUGINS_DIR}/ holding a ${SKILL_DOC_FILE} — ` +
        `e.g. ${PLUGINS_DIR}/<Plugin>/skills/<skill-name>/${SKILL_DOC_FILE}. ` +
        `Nothing outside ${PLUGINS_DIR}/ is read as a skill.`,
      422,
      { kind: 'skill-placement-invalid', path: repoRelativePath },
    );
    this.name = 'SkillPlacementError';
  }
}

/**
 * Strip the clone-folder prefix, turning the workspace-relative path both raw
 * write paths speak into the repo-root-relative path the layout rules are
 * written against. Returns null for anything else, which is the whole of this
 * gate's opinion about malformed paths.
 *
 * Deliberately NO normalisation. `isInsideRepo` refuses backslashes outright
 * (on Windows they separate segments, so `foo\..\..` climbs out) and refuses
 * `.`/`..` segments, and it reports that with a corrected path. Folding those
 * forms into something acceptable here would invent a path semantics the
 * repository rejects, and — on the editor route, where this runs before the
 * write — would answer a malformed path with a SKILL.md placement error
 * instead of the canonical one. On the agent path the question never arises:
 * `assertInsideRepo` runs BEFORE `validateWrite`.
 */
function toRepoRelative(workspaceRelPath: string, kbDirName: string): string | null {
  const prefix = `${kbDirName}/`;
  return workspaceRelPath.startsWith(prefix)
    ? workspaceRelPath.slice(prefix.length)
    : null;
}

/** Is this write targeting a file named `SKILL.md`, wherever it sits? */
function targetsSkillDoc(repoRelativePath: string): boolean {
  return repoRelativePath.split('/').pop() === SKILL_DOC_FILE;
}

/**
 * Throw {@link SkillPlacementError} if `workspaceRelPath` is a `SKILL.md` that
 * the catalog would never find. No-op for every other path — this gate has an
 * opinion about exactly one filename.
 */
export function assertSkillPlacement(workspaceRelPath: string, kbDirName: string): void {
  const repoRel = toRepoRelative(workspaceRelPath, kbDirName);
  if (repoRel === null) return;
  if (!targetsSkillDoc(repoRel)) return;
  if (isSkillDocPath(repoRel)) return;
  throw new SkillPlacementError(repoRel);
}

/**
 * `assertSkillPlacement` bound to a KB dir, for the hooks that take a closure.
 *
 * One closure serves BOTH filesystem hooks — `validateWrite`, whose extra
 * `content` argument this rule has no use for, and `validateCreatePath`. A
 * separate wrapper per hook was two spellings of the same call, which is the
 * drift this change exists to remove.
 */
export function skillPlacementGuardFor(kbDirName: string): (path: string) => void {
  return (path) => assertSkillPlacement(path, kbDirName);
}
