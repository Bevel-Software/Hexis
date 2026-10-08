import { describe, expect, it, vi } from 'vitest';
import { MOVE_LINK_EDIT_CAP, UNSEARCHED_SENTENCE, planMoveLinks, type MoveLinksInput } from '../move-links.js';

/**
 * The plan `move_file` builds for its links: which pages it edits, which it
 * names and leaves, and what it never discloses.
 */

const KB = 'knowledge-base';

function inputOf(
  files: Record<string, string>,
  over: Partial<MoveLinksInput> = {},
): MoveLinksInput & { reads: string[] } {
  const reads: string[] = [];
  return {
    src: `${KB}/Old`,
    dest: `${KB}/New/Old`,
    branch: 'main',
    kbDirName: KB,
    allFiles: Object.keys(files),
    canRead: async (paths) => new Map(paths.map((p) => [p, true])),
    writeBlocked: async () => [],
    readText: async (p) => {
      reads.push(p);
      return files[p];
    },
    hookRefusal: async () => null,
    reads,
    ...over,
  };
}

describe('planMoveLinks', () => {
  it('edits inbound pages and moved pages, reporting each edit at the file’s new path', async () => {
    const files = {
      [`${KB}/Old/One.md`]: '---\nnodeType: "[T](../NodeTypes/Task.md)"\n---\n[two](Two.md)\n',
      [`${KB}/Old/Two.md`]: 'no links\n',
      [`${KB}/Index.md`]: '[one](Old/One.md) and [elsewhere](Other.md)\n',
      [`${KB}/Unrelated.md`]: '[x](Other.md)\n',
      [`${KB}/Old/pic.png`]: 'binary',
    };
    const input = inputOf(files);
    const plan = await planMoveLinks(input);
    expect(plan.report).toEqual({
      filesEdited: 2,
      linksRewritten: 2,
      edits: [
        { path: `${KB}/Index.md`, from: 'Old/One.md', to: 'New/Old/One.md' },
        { path: `${KB}/New/Old/One.md`, from: '../NodeTypes/Task.md', to: '../../NodeTypes/Task.md' },
      ],
      notRewritten: [],
    });
    expect(plan.edits.map((e) => [e.lockAt, e.path])).toEqual([
      [`${KB}/Index.md`, `${KB}/Index.md`],
      [`${KB}/Old/One.md`, `${KB}/New/Old/One.md`],
    ]);
    // Binary files are never read.
    expect(input.reads).not.toContain(`${KB}/Old/pic.png`);
  });

  it('a readable page the caller may not change is named with its links, and not edited', async () => {
    const files = {
      [`${KB}/Old/One.md`]: 'x\n',
      [`${KB}/Locked/Page.md`]: '[one](../Old/One.md)\n',
    };
    const plan = await planMoveLinks(inputOf(files, { writeBlocked: async (paths) => paths.filter((p) => p.includes('Locked')) }));
    expect(plan.edits).toEqual([]);
    expect(plan.report.notRewritten).toEqual([
      { path: `${KB}/Locked/Page.md`, reason: 'no write access', links: ['../Old/One.md'] },
    ]);
  });

  it('a page the caller cannot read is never opened, named or counted — one sentence instead', async () => {
    const files = {
      [`${KB}/Old/One.md`]: 'x\n',
      [`${KB}/Secret/A.md`]: '[one](../Old/One.md)\n',
      [`${KB}/Secret/B.md`]: '[one](../Old/One.md)\n',
    };
    const input = inputOf(files, {
      canRead: async (paths) => new Map(paths.map((p) => [p, !p.includes('Secret')])),
    });
    const plan = await planMoveLinks(input);
    expect(input.reads.some((p) => p.includes('Secret'))).toBe(false);
    expect(plan.report.unsearched).toBe(UNSEARCHED_SENTENCE);
    expect(JSON.stringify(plan.report)).not.toMatch(/Secret|\b2\b/);
    expect(plan.report.filesEdited).toBe(0);
  });

  it('transcripts/ and probes/ folders are never searched', async () => {
    const files = {
      [`${KB}/Old/One.md`]: 'x\n',
      [`${KB}/T/transcripts/01.md`]: '[one](../../Old/One.md)\n',
      [`${KB}/T/probes/p.md`]: '[one](../../Old/One.md)\n',
    };
    const input = inputOf(files);
    const plan = await planMoveLinks(input);
    expect(plan.report.filesEdited).toBe(0);
    expect(input.reads.filter((p) => /transcripts|probes/.test(p))).toEqual([]);
  });

  it('an HTML page is reported, not rewritten', async () => {
    const files = {
      [`${KB}/Old/One.md`]: 'x\n',
      [`${KB}/Board.html`]: '<a href="Old/One.md">one</a>',
    };
    const plan = await planMoveLinks(inputOf(files));
    expect(plan.edits).toEqual([]);
    expect(plan.report.notRewritten).toEqual([{ path: `${KB}/Board.html`, reason: 'html page', links: ['Old/One.md'] }]);
  });

  it('raw HTML inside a markdown page is reported, not rewritten — beside the markdown links that are', async () => {
    const files = {
      [`${KB}/Old/One.md`]: 'x\n',
      [`${KB}/Old/pic.png`]: '',
      // One markdown link, which is rewritten, and one raw `<img>`, which is not.
      [`${KB}/Gallery.md`]: '[one](Old/One.md)\n\n<img src="Old/pic.png" alt="pic">\n',
      // A page whose raw HTML points elsewhere is not named.
      [`${KB}/Other.md`]: '<a href="Elsewhere.md">x</a> mentions Old in prose\n',
    };
    const plan = await planMoveLinks(inputOf(files));
    expect(plan.edits.map((e) => e.path)).toEqual([`${KB}/Gallery.md`]);
    expect(plan.edits[0].content).toBe('[one](New/Old/One.md)\n\n<img src="Old/pic.png" alt="pic">\n');
    expect(plan.report.notRewritten).toEqual([
      { path: `${KB}/Gallery.md`, reason: 'html in markdown', links: ['Old/pic.png'] },
    ]);
  });

  it('raw HTML inside code — a fence, an indented block, a code span — is an example, not reported', async () => {
    const files = {
      [`${KB}/Old/One.md`]: 'x\n',
      [`${KB}/Howto.md`]:
        'Write it like `<a href="Old/One.md">` or:\n\n```html\n<a href="Old/One.md">one</a>\n```\n\n' +
        '    <img src="Old/One.md">\n\nAnd a live one: <a href="Old/One.md">one</a>\n',
    };
    const plan = await planMoveLinks(inputOf(files));
    expect(plan.edits).toEqual([]);
    expect(plan.report.notRewritten).toEqual([
      { path: `${KB}/Howto.md`, reason: 'html in markdown', links: ['Old/One.md'] },
    ]);
  });

  it(`more than ${MOVE_LINK_EDIT_CAP} edited files is refused, saying how to split or switch off`, async () => {
    const files: Record<string, string> = { [`${KB}/Old/One.md`]: 'x\n' };
    for (let i = 0; i <= MOVE_LINK_EDIT_CAP; i++) files[`${KB}/Pages/P${i}.md`] = '[one](../Old/One.md)\n';
    const hookRefusal = vi.fn(async () => null);
    const plan = await planMoveLinks(inputOf(files, { hookRefusal }));
    expect(plan.overCap).toMatch(/201 files.*rewriteLinks: false/s);
    expect(plan.overCap).toMatch(/subfolder/);
    expect(plan.edits).toEqual([]);
    expect(hookRefusal).not.toHaveBeenCalled();
    // Exactly at the cap is allowed.
    delete files[`${KB}/Pages/P0.md`];
    expect((await planMoveLinks(inputOf(files))).overCap).toBeUndefined();
  });

  it('only edited files reach the hooks; a refusal leaves that file named and unedited', async () => {
    const files = {
      [`${KB}/Old/One.md`]: '[t](../T.md)\n',
      [`${KB}/A.md`]: '[one](Old/One.md)\n',
      [`${KB}/B.md`]: '[one](Old/One.md)\n',
      [`${KB}/Searched.md`]: 'mentions Old but links nowhere\n',
    };
    const hookRefusal = vi.fn(async (_lockAt: string, path: string) =>
      path.endsWith('B.md') ? { reason: 'refused: not in this session', read: false } : null);
    const plan = await planMoveLinks(inputOf(files, { hookRefusal }));
    expect(hookRefusal.mock.calls.map((c) => c[0]).sort()).toEqual([`${KB}/A.md`, `${KB}/B.md`, `${KB}/Old/One.md`]);
    expect(plan.edits.map((e) => e.path)).toEqual([`${KB}/A.md`, `${KB}/New/Old/One.md`]);
    expect(plan.report.notRewritten).toEqual([{ path: `${KB}/B.md`, reason: 'refused: not in this session', links: ['Old/One.md'] }]);
  });

  it('a page the read hook refuses is treated as unreadable: never named, one sentence instead', async () => {
    const files = {
      [`${KB}/Old/One.md`]: 'x\n',
      [`${KB}/Hidden.md`]: '[one](Old/One.md) [secret](Secret/Target.md)\n',
    };
    const plan = await planMoveLinks(inputOf(files, { hookRefusal: async () => ({ reason: 'refused: read denied', read: true }) }));
    expect(plan.edits).toEqual([]);
    expect(plan.report.notRewritten).toEqual([]);
    expect(plan.report.unsearched).toBe(UNSEARCHED_SENTENCE);
    expect(JSON.stringify(plan.report)).not.toMatch(/Hidden|Secret|read denied/);
  });

  it('a link spelling the moved name with percent-encoding or escapes is still found', async () => {
    const files = {
      [`${KB}/My Old (1)/One.md`]: 'x\n',
      [`${KB}/Lower.md`]: '[one](My%20Old%20%281%29/One.md)\n',
      [`${KB}/Partial.md`]: '[one](My%20Old%20(1)/One.md)\n',
      [`${KB}/Escaped.md`]: '[one](My%20Old%20\\(1\\)/One.md)\n',
      [`${KB}/Mixed.md`]: '[one](%4dy%20Old%20%281%29/One.md)\n',
    };
    const plan = await planMoveLinks(inputOf(files, { src: `${KB}/My Old (1)`, dest: `${KB}/New/My Old (1)` }));
    expect(plan.edits.map((e) => e.path).sort()).toEqual([`${KB}/Escaped.md`, `${KB}/Lower.md`, `${KB}/Mixed.md`, `${KB}/Partial.md`]);
  });

  it('a page gone between the listing and its read is skipped; one that cannot be opened marks the search incomplete', async () => {
    const files = {
      [`${KB}/Old/One.md`]: 'x\n',
      [`${KB}/Gone.md`]: '[one](Old/One.md)\n',
      [`${KB}/Index.md`]: '[one](Old/One.md)\n',
    };
    const failWith = (code: string) => async (p: string) => {
      if (p.endsWith('Gone.md')) throw Object.assign(new Error(code), { code });
      return files[p as keyof typeof files];
    };
    const gone = await planMoveLinks(inputOf(files, { readText: failWith('ENOENT') }));
    expect(gone.edits.map((e) => e.path)).toEqual([`${KB}/Index.md`]);
    expect(gone.report.unsearched).toBeUndefined();
    const denied = await planMoveLinks(inputOf(files, { readText: failWith('EACCES') }));
    expect(denied.edits.map((e) => e.path)).toEqual([`${KB}/Index.md`]);
    expect(denied.report.unsearched).toBe(UNSEARCHED_SENTENCE);
    expect(JSON.stringify(denied.report)).not.toMatch(/Gone/);
  });

  it('lists at most 100 edits while counting all of them', async () => {
    const files: Record<string, string> = { [`${KB}/Old/One.md`]: 'x\n' };
    for (let i = 0; i < 60; i++) files[`${KB}/Pages/P${i}.md`] = '[a](../Old/One.md) [b](../Old/One.md#x)\n';
    const plan = await planMoveLinks(inputOf(files));
    expect(plan.report.filesEdited).toBe(60);
    expect(plan.report.linksRewritten).toBe(120);
    expect(plan.report.edits).toHaveLength(100);
  });
});
