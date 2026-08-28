import { describe, test, expect } from 'vitest';
import {
  SkillPlacementError,
  assertSkillPlacement,
  skillPlacementGuardFor,
} from '../skill-placement-guard.js';

/**
 * The bug this exists for: a `SKILL.md` written outside `Plugins/` passed every
 * write gate, committed, pushed, and was then ignored by the catalog, the
 * review shelf and the Library alike. The write said "saved" and no skill
 * existed. So these tests are mostly about the boundary — what counts as a
 * place a skill can live — because refusing too much is as broken as refusing
 * nothing.
 */

const KB = 'knowledge-base';

describe('assertSkillPlacement', () => {
  test('accepts the documented shape', () => {
    expect(() =>
      assertSkillPlacement(`${KB}/Plugins/GTM/skills/heyreach/SKILL.md`, KB),
    ).not.toThrow();
  });

  /**
   * A SKILL.md directly in a PLUGIN folder is refused, and this is the case
   * that matters most. The scanner stops descending at the first folder holding
   * a SKILL.md, so `Plugins/GTM/SKILL.md` makes `Plugins/GTM` itself the skill
   * and hides every real skill under `Plugins/GTM/skills/`. One file, a plugin's
   * whole catalog gone — the write gate must not bless that.
   */
  test('refuses a SKILL.md directly in a plugin folder, which would hide its skills', () => {
    expect(() => assertSkillPlacement(`${KB}/Plugins/GTM/SKILL.md`, KB)).toThrow(
      SkillPlacementError,
    );
    expect(() => assertSkillPlacement(`${KB}/Plugins/loose-skill/SKILL.md`, KB)).toThrow(
      SkillPlacementError,
    );
  });

  test('accepts a skill nested under extra grouping folders', () => {
    expect(() =>
      assertSkillPlacement(`${KB}/Plugins/Engineering/coding/review/bug-hunt/SKILL.md`, KB),
    ).not.toThrow();
  });

  /** The actual reported case: the pre-migration root, which nothing reads. */
  test('refuses the legacy Skills/ root', () => {
    expect(() => assertSkillPlacement(`${KB}/Skills/example/SKILL.md`, KB)).toThrow(
      SkillPlacementError,
    );
  });

  test('refuses a SKILL.md anywhere outside Plugins/', () => {
    expect(() => assertSkillPlacement(`${KB}/KnowledgeBase/Product/SKILL.md`, KB)).toThrow(
      SkillPlacementError,
    );
    expect(() => assertSkillPlacement(`${KB}/SKILL.md`, KB)).toThrow(SkillPlacementError);
  });

  /** `Plugins/` is a root, not a skill — a SKILL.md directly in it names nothing. */
  test('refuses a SKILL.md loose in the Plugins root', () => {
    expect(() => assertSkillPlacement(`${KB}/Plugins/SKILL.md`, KB)).toThrow(SkillPlacementError);
  });

  test('the refusal names the path that would work', () => {
    try {
      assertSkillPlacement(`${KB}/Skills/example/SKILL.md`, KB);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(SkillPlacementError);
      const e = err as SkillPlacementError;
      expect(e.status).toBe(422);
      // The whole point is replacing a silent no-op with an instruction.
      expect(e.message).toContain('Plugins/<Plugin>/skills/<skill-name>/SKILL.md');
      // And it must say which path it rejected, repo-relative (no clone prefix).
      expect(e.message).toContain('Skills/example/SKILL.md');
      expect(e.repoRelativePath).toBe('Skills/example/SKILL.md');
    }
  });

  /**
   * The gate has an opinion about exactly one filename. Everything else in the
   * KB — nodes, tool manuals, access.md, bundled assets — is none of its
   * business, including files that merely live beside a skill.
   */
  test('ignores every path that is not a SKILL.md', () => {
    for (const p of [
      `${KB}/Skills/example/checklist.md`,
      `${KB}/KnowledgeBase/Product/Anything.md`,
      `${KB}/Plugins/GTM/access.md`,
      `${KB}/roles.yaml`,
      `${KB}/Plugins/GTM/skills/heyreach/reference.md`,
    ]) {
      expect(() => assertSkillPlacement(p, KB)).not.toThrow();
    }
  });

  /** Case-sensitive, matching the scanner's own `e.name === 'SKILL.md'` check. */
  test('does not fire on a differently-cased filename', () => {
    expect(() => assertSkillPlacement(`${KB}/Skills/example/Skill.md`, KB)).not.toThrow();
  });

  /**
   * A malformed path is not this gate's to judge. `isInsideRepo` refuses
   * backslashes and `.`/`..` segments outright and answers with a corrected
   * path; normalising them here would invent a semantics the repository
   * rejects and would swap that answer for a placement error. Staying silent
   * leaves the canonical refusal in place.
   */
  test('stays silent on a path the repository would reject as malformed', () => {
    for (const p of [
      `./${KB}/Skills/example/SKILL.md`,
      `${KB}\\Skills\\example\\SKILL.md`,
      `/${KB}/Skills/example/SKILL.md`,
    ]) {
      expect(() => assertSkillPlacement(p, KB)).not.toThrow();
    }
  });

  /**
   * A path outside the clone folder is `assertInsideRepo`'s refusal to make,
   * and it runs first. Judging it here would only produce a second, worse-worded
   * error for the same mistake.
   */
  test('stays silent on a path outside the KB clone', () => {
    expect(() => assertSkillPlacement('elsewhere/Skills/example/SKILL.md', KB)).not.toThrow();
  });

  test('honours a non-default clone folder name', () => {
    expect(() =>
      assertSkillPlacement('unite-process-map/Plugins/RFI/skills/rfi-answer/SKILL.md', 'unite-process-map'),
    ).not.toThrow();
    expect(() =>
      assertSkillPlacement('unite-process-map/Skills/example/SKILL.md', 'unite-process-map'),
    ).toThrow(SkillPlacementError);
  });
});

describe('skillPlacementGuardFor', () => {
  /**
   * ONE closure for both filesystem hooks. `validateWrite` passes content it
   * has no use for here and `validateCreatePath` passes none at all; a wrapper
   * per hook was two spellings of the same call.
   */
  test('refuses a misplaced skill write and passes a well-placed one', () => {
    const guard = skillPlacementGuardFor(KB);
    expect(() => guard(`${KB}/Skills/example/SKILL.md`)).toThrow(SkillPlacementError);
    expect(() => guard(`${KB}/Plugins/GTM/skills/example/SKILL.md`)).not.toThrow();
  });

  test('honours a non-default clone folder name', () => {
    const guard = skillPlacementGuardFor('unite-process-map');
    expect(() => guard('unite-process-map/Skills/example/SKILL.md')).toThrow(SkillPlacementError);
    expect(() =>
      guard('unite-process-map/Plugins/RFI/skills/rfi-answer/SKILL.md'),
    ).not.toThrow();
  });
});
