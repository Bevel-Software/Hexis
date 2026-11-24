import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useState, type ComponentType } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { dominantEol, restoreLineEndings } from '@bevel-software/platform-shared';
import { GitContext, type GitContextValue } from '../../../../git';
import { WorkspaceContext } from '../../../state/workspace.context';
import { makeWorkspaceFixture } from '../../../__tests__/testFixtures';
import { pickFileRenderer, type FileRendererProps } from '..';

/**
 * A browser's `<textarea>` hands its text back with every line break as LF,
 * whatever it was given: the HTML standard defines its `value` (the "API
 * value") as the raw value with newlines normalized. happy-dom hands back
 * exactly what was set, so without this a unit test never sees what the app's
 * editor does to a CRLF file. The browser's rule, for this suite.
 */
const textareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
beforeAll(() => {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
    ...textareaValue,
    get(this: HTMLTextAreaElement) {
      return (textareaValue.get!.call(this) as string).replace(/\r\n?/g, '\n');
    },
  });
});
afterAll(() => {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'value', textareaValue);
});

function makeGit(): GitContextValue {
  return {
    status: { branch: 'alice/draft', hasUpstream: true, unmergedFromUpstream: false },
    branches: [],
    availability: 'ready',
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    deleteBranch: async () => {},
    pull: async () => {},
    fetchForkBase: async () => null,
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileAtChange: async () => ({ baseline: null, current: null }),
    fetchFileComparison: async () => '',
  };
}

/**
 * What an editing host does with a renderer: the file page keeps the typed
 * text (`onValueChange`) on the tab, writes what `onSave` hands it on Ctrl+S,
 * and writes the tab's text on Done and on its background autosave, which
 * then becomes the saved version. The file's text goes in; whatever comes out
 * is what would be written.
 */
function EditingHost({
  Renderer,
  path,
  file,
  onWrite,
  onDirty,
}: {
  Renderer: ComponentType<FileRendererProps>;
  path: string;
  file: string;
  onWrite: (bytes: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState(file);
  const [buffer, setBuffer] = useState(file);
  return (
    <MemoryRouter>
      <WorkspaceContext.Provider value={makeWorkspaceFixture()}>
        <GitContext.Provider value={makeGit()}>
          <button
            type="button"
            onClick={() => {
              onWrite(buffer);
              setSaved(buffer);
            }}
          >
            Autosave
          </button>
          <Renderer
            content={buffer}
            savedContent={saved}
            filePath={path}
            readOnly={false}
            onValueChange={setBuffer}
            onDirtyChange={onDirty}
            onSave={async (bytes) => {
              onWrite(bytes);
              setSaved(bytes);
              setBuffer(bytes);
            }}
          />
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>
  );
}

/**
 * Edit `file` the way a person does, save it (Ctrl+S, or the host writing the
 * typed text as Done and autosave do), and answer what would be written.
 */
async function editAndSave(
  path: string,
  file: string,
  typed: string,
  at: 'start' | 'end',
  save: 'ctrl+s' | 'autosave' = 'ctrl+s',
): Promise<{ written: string[]; dirty: ReturnType<typeof vi.fn> }> {
  const user = userEvent.setup();
  const written: string[] = [];
  const dirty = vi.fn();
  render(
    <EditingHost
      // The renderer the file page and the embed would mount for this file.
      Renderer={pickFileRenderer(path)}
      path={path}
      file={file}
      onWrite={(b) => written.push(b)}
      onDirty={dirty}
    />,
  );
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  const caret = at === 'start' ? 0 : textarea.value.length;
  await user.type(textarea, typed, { initialSelectionStart: caret, initialSelectionEnd: caret });
  if (save === 'ctrl+s') await user.keyboard('{Control>}s{/Control}');
  else await user.click(screen.getByRole('button', { name: 'Autosave' }));
  await waitFor(() => expect(written).toHaveLength(1));
  return { written, dirty };
}

describe("an editing renderer writes the file's own line endings back", () => {
  it('saves a CRLF page edited at its end with every untouched line ending intact', async () => {
    const file = '# CRLF\r\n\r\nalpha\r\nbeta\r\n';
    const { written } = await editAndSave('knowledge-base/QA-Edit/crlf.md', file, 'gamma', 'end');
    expect(written).toEqual([`${file}gamma`]);
  });

  it('saves a CRLF page edited on its first line with the other lines untouched', async () => {
    const { written } = await editAndSave(
      'knowledge-base/QA-Edit/crlf2.md',
      'one\r\ntwo\r\nthree\r\n',
      'zero ',
      'start',
    );
    expect(written).toEqual(['zero one\r\ntwo\r\nthree\r\n']);
  });

  it('keeps an LF page LF', async () => {
    const { written } = await editAndSave('knowledge-base/notes.md', 'one\ntwo\n', 'three\n', 'end');
    expect(written).toEqual(['one\ntwo\nthree\n']);
  });

  it('keeps CRLF in a plain-text file too, not only in a Markdown page', async () => {
    const { written } = await editAndSave('knowledge-base/notes.txt', 'a\r\nb\r\n', 'c', 'end');
    expect(written).toEqual(['a\r\nb\r\nc']);
  });

  it('hands the host the typed text in CRLF, which is what Done and autosave write', async () => {
    const { written } = await editAndSave('knowledge-base/notes.md', 'a\r\nb\r\n', 'c', 'end', 'autosave');
    expect(written).toEqual(['a\r\nb\r\nc']);
  });

  // The Markdown editor keeps its own buffer while editing (it does not
  // re-read `content`), so it is the one whose "unsaved" check would compare
  // its LF buffer with the CRLF saved version an autosave hands it.
  it('is not left looking unsaved after an autosave of a CRLF page', async () => {
    const { dirty } = await editAndSave('knowledge-base/notes.md', 'a\r\nb\r\n', 'c', 'end', 'autosave');
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  });
});

/** What a textarea hands back for `text`. */
const asTyped = (text: string) => text.replace(/\r\n?/g, '\n');

/** Files to edit: every mix of endings, with and without a last line break. */
const FILES = [
  '',
  'one line',
  'a\r\nb\r\nc\r\n',
  'a\r\nb\r\nc',
  'a\nb\nc\n',
  '# CRLF\r\n\r\nalpha\r\nbeta\r\n',
  'mostly\r\ncrlf\r\nbut\none\r\nis lf\r\n',
  'mostly\nlf\nbut\r\none\nis crlf\n',
  'tie\r\nfirst wins\n',
];

/** `file` split after each LF, every line with its own ending. */
const linesOf = (file: string) => file.match(/[^\n]*\n|[^\n]+$/g) ?? [];

describe('restoreLineEndings', () => {
  it('gives back text nobody changed byte for byte, whatever its endings', () => {
    for (const file of FILES) expect(restoreLineEndings(file, asTyped(file))).toBe(file);
  });

  it('changes only the line that was edited, on every line of every file', () => {
    for (const file of FILES) {
      const lines = linesOf(file);
      lines.forEach((line, i) => {
        const typed = linesOf(asTyped(file));
        typed[i] = typed[i].replace(/^[^\n]*/, 'EDITED');
        const ending = line.endsWith('\n') ? dominantEol(file) : '';
        const expected = [...lines.slice(0, i), `EDITED${ending}`, ...lines.slice(i + 1)].join('');
        expect(restoreLineEndings(file, typed.join(''))).toBe(expected);
      });
    }
  });

  it('gives lines added to a CRLF file CRLF, and to an LF file LF', () => {
    expect(restoreLineEndings('a\r\nb\r\n', 'a\nnew\nb\n')).toBe('a\r\nnew\r\nb\r\n');
    expect(restoreLineEndings('a\nb\n', 'a\nnew\nb\n')).toBe('a\nnew\nb\n');
    expect(restoreLineEndings('a\r\nb', 'a\nb\nc\nd')).toBe('a\r\nb\r\nc\r\nd');
  });

  it('removes a deleted line and leaves the rest as they were', () => {
    expect(restoreLineEndings('a\r\nb\nc\r\n', 'a\nc\n')).toBe('a\r\nc\r\n');
    expect(restoreLineEndings('x\r\nx\nx\r\n', 'x\nx\n')).toBe('x\r\nx\n');
  });

  it("gives the lines of a mixed file's edit the ending most of its lines have", () => {
    expect(restoreLineEndings('a\r\nb\nc\r\n', 'a\nB\nc\n')).toBe('a\r\nB\r\nc\r\n');
    expect(restoreLineEndings('a\nb\r\nc\n', 'a\nB\nc\n')).toBe('a\nB\nc\n');
  });

  it('adds one line when a copy of a neighbouring line is inserted, and leaves the neighbours alone', () => {
    // `y\n` keeps its LF; the one new line takes the majority's CRLF.
    expect(restoreLineEndings('x\r\ny\nz\r\n', 'x\ny\ny\nz\n')).toBe('x\r\ny\ny\r\nz\r\n');
  });

  /**
   * Every file of up to three lines over two texts and both endings (the last
   * line with or without one), and every single run of changed lines in it:
   * lines i..j replaced by up to two new lines, copies of their neighbours
   * included. What git would show as changed (lines removed plus lines added,
   * endings counted) is never more than the edit itself.
   */
  it("never shows one edit as more changed lines than the edit, duplicates and mixed endings included", () => {
    const changedLines = (a: string[], b: string[]) => {
      const dp = a.map(() => new Array<number>(b.length + 1).fill(0)).concat([new Array(b.length + 1).fill(0)]);
      for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      return a.length + b.length - 2 * dp[0][0];
    };
    const lineSets = (n: number): string[][] =>
      n === 0 ? [[]] : lineSets(n - 1).flatMap((ls) => ['a', 'b'].flatMap((t) => ['\r\n', '\n'].map((e) => [...ls, t + e])));
    const inserts = (n: number): string[][] =>
      n === 0 ? [[]] : inserts(n - 1).flatMap((ls) => ['a', 'b', 'c'].map((t) => [...ls, `${t}\n`]));
    let cases = 0;
    for (let n = 0; n <= 3; n++) {
      for (const full of lineSets(n)) {
        // The same lines, and (when there are any) with the last one unended.
        const variants = n === 0 ? [full] : [full, [...full.slice(0, -1), full[n - 1].replace(/\r?\n$/, '')]];
        for (const lines of variants) {
          const file = lines.join('');
          const typed = linesOf(asTyped(file));
          for (let i = 0; i <= n; i++)
            for (let j = i; j <= n; j++)
              for (let k = 0; k <= 2; k++)
                for (const added of inserts(k)) {
                  // Text typed after an unended last line joins that line: not a run of whole lines.
                  if (i === n && k > 0 && n > 0 && !file.endsWith('\n')) continue;
                  const edited = [...typed.slice(0, i), ...added, ...typed.slice(j)].join('');
                  const saved = restoreLineEndings(file, edited);
                  expect(asTyped(saved)).toBe(edited);
                  expect(changedLines(lines, linesOf(saved))).toBeLessThanOrEqual(j - i + k);
                  cases++;
                }
        }
      }
    }
    expect(cases).toBeGreaterThan(5000);
  });
});
