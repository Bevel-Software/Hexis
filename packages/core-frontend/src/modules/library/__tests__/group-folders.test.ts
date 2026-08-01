import { describe, it, expect } from 'vitest';
import { groupFoldersFor } from '../utils/group-folders';

/**
 * A group is a folder — except mid-migration, when it is two or three of them,
 * each with its own `access.md`. These cases are what decides whether the access
 * section shows one card or several, so the derivation has to agree with
 * `groupOfPath` exactly rather than approximately.
 */
describe('groupFoldersFor', () => {
  it('resolves a migrated group to its single Groups/ folder', () => {
    expect(groupFoldersFor('GTM', ['Groups/GTM/outreach/SKILL.md', 'Groups/GTM/slack.tool'])).toEqual([
      { folder: 'Groups/GTM', root: 'Groups' },
    ]);
  });

  it('reports both legacy roots for an unmigrated group', () => {
    expect(groupFoldersFor('GTM', ['Skills/GTM/outreach', 'Tools/GTM/slack.tool'])).toEqual([
      { folder: 'Skills/GTM', root: 'Skills' },
      { folder: 'Tools/GTM', root: 'Tools' },
    ]);
  });

  it('puts the migration destination first when a group spans all three roots', () => {
    expect(
      groupFoldersFor('GTM', [
        'Tools/GTM/slack.tool',
        'Skills/GTM/outreach',
        'Groups/GTM/newer/SKILL.md',
      ]),
    ).toEqual([
      { folder: 'Groups/GTM', root: 'Groups' },
      { folder: 'Skills/GTM', root: 'Skills' },
      { folder: 'Tools/GTM', root: 'Tools' },
    ]);
  });

  it('dedupes many items in the same folder', () => {
    expect(
      groupFoldersFor('GTM', [
        'Groups/GTM/a/SKILL.md',
        'Groups/GTM/b/SKILL.md',
        'Groups/GTM/c.tool',
      ]),
    ).toEqual([{ folder: 'Groups/GTM', root: 'Groups' }]);
  });

  it('ignores a tool that sits in no group at all', () => {
    // `Tools/slack.tool` is two segments — `groupOfPath` calls that ungrouped,
    // and reading it as a group named "slack.tool" is exactly the bug this
    // three-segment rule exists to prevent.
    expect(groupFoldersFor('slack.tool', ['Tools/slack.tool'])).toEqual([]);
  });

  it('ignores other groups and non-group roots', () => {
    expect(
      groupFoldersFor('GTM', [
        'Groups/Product/roadmap/SKILL.md',
        'KnowledgeBase/GTM/Knowledge/Thing.md',
      ]),
    ).toEqual([]);
  });

  it('returns nothing for an empty catalog', () => {
    expect(groupFoldersFor('GTM', [])).toEqual([]);
  });
});
