import { describe, it, expect } from 'vitest';
import { isGroupItemPath } from '../ReviewPanel';

const KB = 'knowledge-base';

/**
 * The predicate behind "selecting a changed skill must not switch apps".
 *
 * Tested here rather than through the panel because the panel's file picker
 * does not open under the component harness — an earlier attempt to cover this
 * through the UI passed with the guard DELETED, which is worse than no test.
 *
 * The first version of this check shipped broken for exactly the reason the
 * first case below pins: review-session paths are WORKSPACE-relative, so they
 * carry the KB clone as their first segment, and `stripJunkBeforeKbDir` keeps
 * that segment rather than removing it. `groupOfPath` then saw
 * `knowledge-base` where it wanted `Groups` and answered `null` for every
 * path — a guard that could never fire.
 */
describe('isGroupItemPath', () => {
  it.each([
    ['skill, workspace-relative', `${KB}/Groups/GTM/update-website/SKILL.md`],
    ['tool, workspace-relative', `${KB}/Groups/Engineering/notion.tool`],
    ['personal group', `${KB}/Groups/personal-u1/my-skill/SKILL.md`],
  ])('recognises a %s', (_name, path) => {
    expect(isGroupItemPath(path, KB)).toBe(true);
  });

  it.each([
    ['knowledge document', `${KB}/KnowledgeBase/Product/Thing.md`],
    ['repo-root file', `${KB}/roles.yaml`],
    ['data record', `${KB}/Data/Engineering/Knowledge/Ticket.md`],
  ])('leaves a %s alone', (_name, path) => {
    expect(isGroupItemPath(path, KB)).toBe(false);
  });

  /**
   * Not every caller hands over a workspace-relative path — the panel's own
   * fixtures use repo-relative ones — so both shapes have to work.
   */
  it('accepts an already repo-relative path', () => {
    expect(isGroupItemPath('Groups/GTM/x/SKILL.md', KB)).toBe(true);
    expect(isGroupItemPath('KnowledgeBase/Product/Thing.md', KB)).toBe(false);
  });

  it('tolerates junk before the kb dir, which is what strip exists for', () => {
    expect(isGroupItemPath(`some/prefix/${KB}/Groups/GTM/x/SKILL.md`, KB)).toBe(true);
  });

  it('does not treat the Groups folder itself as an item', () => {
    // `groupOfPath` needs a segment BELOW the group; `Groups/GTM` is the
    // folder, and a bare `Groups/x.tool` names no group at all.
    expect(isGroupItemPath(`${KB}/Groups/GTM`, KB)).toBe(false);
    expect(isGroupItemPath(`${KB}/Groups/slack.tool`, KB)).toBe(false);
  });

  /**
   * A sibling directory whose name merely STARTS with the kb dir is not the
   * clone, so nothing inside it is a group item. Both the segment-exact match
   * in `stripJunkBeforeKbDir` and the `${kbDirName}/` prefix test added here
   * have to agree on that — a `startsWith(kbDirName)` in either would strip
   * `-backup/…` down to `Groups/…` and call a backup copy a live skill.
   */
  it('is not fooled by a directory whose name merely starts with the kb dir', () => {
    expect(isGroupItemPath(`${KB}-backup/Groups/GTM/x/SKILL.md`, KB)).toBe(false);
  });

  it('handles a null kbDirName', () => {
    expect(isGroupItemPath('Groups/GTM/x/SKILL.md', null)).toBe(true);
    expect(isGroupItemPath('KnowledgeBase/Thing.md', null)).toBe(false);
  });
});
