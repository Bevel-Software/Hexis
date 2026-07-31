import { describe, it, expect } from 'vitest';
import {
  groupOfPath,
  GROUPS_DIR,
  LEGACY_SKILLS_DIR,
  LEGACY_TOOLS_DIR,
} from '@bevel-software/platform-shared';

/**
 * `groupOfPath` is the whole of the grouping contract — the sidebar, the
 * catalog buckets and the access story all read a group off a path with it.
 * The cases that matter are the ones where "has a group" and "is under a group
 * root" come apart.
 */
describe('groupOfPath', () => {
  it('reads the group from the merged root', () => {
    expect(groupOfPath(`${GROUPS_DIR}/GTM/heyreach-campaign/SKILL.md`)).toBe('GTM');
    expect(groupOfPath(`${GROUPS_DIR}/GTM/heyreach.tool`)).toBe('GTM');
    expect(groupOfPath(`${GROUPS_DIR}/Engineering/review/architecture-review`)).toBe(
      'Engineering',
    );
  });

  it('reads the group from the pre-merge roots too', () => {
    // This is what lets the group navigation ship before the KB content moves.
    expect(groupOfPath(`${LEGACY_SKILLS_DIR}/GTM/heyreach-campaign`)).toBe('GTM');
    expect(groupOfPath(`${LEGACY_TOOLS_DIR}/NewsAgent/serper.tool`)).toBe('NewsAgent');
  });

  it('returns null for content directly under a root — it has no group folder', () => {
    // The regression this guards: `Tools/slack.tool` must NOT report a group
    // called "slack.tool", and `Groups/GTM` must not report itself.
    expect(groupOfPath(`${LEGACY_TOOLS_DIR}/slack.tool`)).toBeNull();
    expect(groupOfPath(`${LEGACY_SKILLS_DIR}/create-tool-manual`)).toBeNull();
    expect(groupOfPath(`${GROUPS_DIR}/GTM`)).toBeNull();
    expect(groupOfPath(GROUPS_DIR)).toBeNull();
  });

  it('returns null outside the group roots', () => {
    expect(groupOfPath('KnowledgeBase/Product/Knowledge/Foo.md')).toBeNull();
    expect(groupOfPath('Data/Engineering/Knowledge/Bar.md')).toBeNull();
    expect(groupOfPath('access.md')).toBeNull();
    expect(groupOfPath('')).toBeNull();
  });

  it('is not fooled by a prefix match on the root name', () => {
    // `SkillsArchive` starts with `Skills` but is a different folder.
    expect(groupOfPath('SkillsArchive/GTM/old-skill')).toBeNull();
    expect(groupOfPath('GroupsOld/GTM/x')).toBeNull();
  });

  it('tolerates leading and doubled separators', () => {
    expect(groupOfPath(`/${GROUPS_DIR}/GTM/x`)).toBe('GTM');
    expect(groupOfPath(`${GROUPS_DIR}//GTM//x`)).toBe('GTM');
  });
});
