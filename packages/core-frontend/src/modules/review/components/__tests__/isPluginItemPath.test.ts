import { describe, it, expect, beforeEach } from 'vitest';
import { configureBranchModel } from '@bevel-software/platform-shared';
import { isPluginItemPath, shouldOpenBesideDiff } from '../ReviewPanel';

const DEFAULT = 'target-company-state';
const DRAFT = 'razvan/onboarding-tweaks';

beforeEach(() => {
  configureBranchModel({
    defaultBranch: DEFAULT,
    protectedBranches: ['current-company-state', DEFAULT],
  });
});

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
 * that segment rather than removing it. `pluginOfPath` then saw
 * `knowledge-base` where it wanted `Plugins` and answered `null` for every
 * path — a guard that could never fire.
 */
describe('isPluginItemPath', () => {
  it.each([
    ['skill, workspace-relative', `${KB}/Plugins/GTM/update-website/SKILL.md`],
    ['tool, workspace-relative', `${KB}/Plugins/Engineering/notion.tool`],
    ['personal plugin', `${KB}/Plugins/personal-u1/my-skill/SKILL.md`],
  ])('recognises a %s', (_name, path) => {
    expect(isPluginItemPath(path, KB)).toBe(true);
  });

  it.each([
    ['knowledge document', `${KB}/KnowledgeBase/Product/Thing.md`],
    ['repo-root file', `${KB}/roles.yaml`],
    ['data record', `${KB}/Data/Engineering/Knowledge/Ticket.md`],
  ])('leaves a %s alone', (_name, path) => {
    expect(isPluginItemPath(path, KB)).toBe(false);
  });

  /**
   * Not every caller hands over a workspace-relative path — the panel's own
   * fixtures use repo-relative ones — so both shapes have to work.
   */
  it('accepts an already repo-relative path', () => {
    expect(isPluginItemPath('Plugins/GTM/x/SKILL.md', KB)).toBe(true);
    expect(isPluginItemPath('KnowledgeBase/Product/Thing.md', KB)).toBe(false);
  });

  it('tolerates junk before the kb dir, which is what strip exists for', () => {
    expect(isPluginItemPath(`some/prefix/${KB}/Plugins/GTM/x/SKILL.md`, KB)).toBe(true);
  });

  it('does not treat the Plugins folder itself as an item', () => {
    // `pluginOfPath` needs a segment BELOW the plugin; `Plugins/GTM` is the
    // folder, and a bare `Plugins/x.tool` names no plugin at all.
    expect(isPluginItemPath(`${KB}/Plugins/GTM`, KB)).toBe(false);
    expect(isPluginItemPath(`${KB}/Plugins/slack.tool`, KB)).toBe(false);
  });

  /**
   * A sibling directory whose name merely STARTS with the kb dir is not the
   * clone, so nothing inside it is a plugin item. Both the segment-exact match
   * in `stripJunkBeforeKbDir` and the `${kbDirName}/` prefix test added here
   * have to agree on that — a `startsWith(kbDirName)` in either would strip
   * `-backup/…` down to `Plugins/…` and call a backup copy a live skill.
   */
  it('is not fooled by a directory whose name merely starts with the kb dir', () => {
    expect(isPluginItemPath(`${KB}-backup/Plugins/GTM/x/SKILL.md`, KB)).toBe(false);
  });

  it('handles a null kbDirName', () => {
    expect(isPluginItemPath('Plugins/GTM/x/SKILL.md', null)).toBe(true);
    expect(isPluginItemPath('KnowledgeBase/Thing.md', null)).toBe(false);
  });
});

/**
 * The full decision behind "selecting a row also opens the file beside the
 * diff". Tested here for the same reason as the predicate above: the call
 * site is behind a dropdown the component harness cannot open.
 */
describe('shouldOpenBesideDiff', () => {
  const base = { kbDirName: KB, branch: DEFAULT } as const;
  const SKILL = `${KB}/Plugins/GTM/update-website/SKILL.md`;
  const DOC = `${KB}/KnowledgeBase/Product/Thing.md`;

  it('opens an ordinary knowledge document', () => {
    expect(shouldOpenBesideDiff({ ...base, kind: 'modified', path: DOC })).toBe(true);
  });

  it('does NOT open a skill on the default branch — that switches apps', () => {
    expect(shouldOpenBesideDiff({ ...base, kind: 'modified', path: SKILL })).toBe(false);
  });

  /**
   * Only the DEFAULT branch's `Plugins/` URLs are library locations
   * (`isLibraryLocation` tests `segments[1] === DEFAULT_BRANCH`). On a draft
   * branch the same skill opens in Knowledge and switches nothing, so the
   * guard must not fire — refusing there would cost the context this call
   * exists to give and buy nothing.
   */
  it('DOES open the same skill on a draft branch', () => {
    expect(shouldOpenBesideDiff({ ...base, branch: DRAFT, kind: 'modified', path: SKILL })).toBe(true);
  });

  it.each(['modified', 'added', 'renamed'] as const)('opens a %s knowledge file', (kind) => {
    expect(shouldOpenBesideDiff({ ...base, kind, path: DOC })).toBe(true);
  });

  it('never opens a deleted file, wherever it lives', () => {
    expect(shouldOpenBesideDiff({ ...base, kind: 'deleted', path: DOC })).toBe(false);
    expect(shouldOpenBesideDiff({ ...base, kind: 'deleted', path: SKILL })).toBe(false);
    expect(shouldOpenBesideDiff({ ...base, branch: DRAFT, kind: 'deleted', path: SKILL })).toBe(false);
  });

  it('treats an unknown branch as not-the-default, so it opens', () => {
    expect(shouldOpenBesideDiff({ ...base, branch: null, kind: 'modified', path: SKILL })).toBe(true);
  });
});
