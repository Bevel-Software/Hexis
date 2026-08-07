import { useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import type { FileDiffPayload } from '@bevel-software/platform-shared';
import { computeDiff, type DiffLine } from '../../workspace/utils/diff';
import { parseFrontmatter, labelFor, type FrontmatterData } from '../../workspace/utils/frontmatter';

const MAX_RENDERED_LINES = 5000;

const MD_COMPONENTS = {
  a: ({ href, children, ...props }: React.ComponentPropsWithoutRef<'a'>) =>
    href && /^https?:\/\//i.test(href)
      ? <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>
      : <a href={href} {...props}>{children}</a>,
};

/**
 * Frontmatter-aware diff renderer for markdown files. Splits the diff into
 * frontmatter and body regions; renders the frontmatter as a structured
 * key-by-key red/green panel (rather than raw `key: value` lines), and the
 * body as either a markdown-rendered preview with red/green change blocks or
 * a git-conflict-marker view for side-by-side text inspection.
 */
export function MarkdownDiffViewer({ payload }: { payload: FileDiffPayload }) {
  const data = useMemo(() => {
    const baseline = payload.baseline ?? '';
    const current = payload.current ?? '';
    // Cheap pre-check: count newlines before doing the LCS + frontmatter +
    // markdown-rendering work. The diff line count can't exceed baselineLines +
    // currentLines, so if their sum already exceeds the render cap we know the
    // result is "too large" and can skip the heavy computation entirely.
    const rawLineCount = countNewlines(baseline) + countNewlines(current) + 2;
    if (rawLineCount > MAX_RENDERED_LINES) {
      return {
        tooLarge: true as const,
        rawLineCount,
        lines: [] as DiffLine[],
        bodyBlocks: [] as DisplayBlock[],
        frontmatterChanged: false,
        oldFrontmatter: {} as FrontmatterData,
        newFrontmatter: {} as FrontmatterData,
      };
    }
    const lines = computeDiff(baseline, current);
    const oldFmEnd = frontmatterLineCount(baseline);
    const newFmEnd = frontmatterLineCount(current);
    const split = splitDiffByFrontmatter(lines, oldFmEnd, newFmEnd);
    return {
      tooLarge: false as const,
      rawLineCount,
      lines,
      bodyBlocks: groupDiffBlocks(split.body),
      frontmatterChanged: split.frontmatter.some((l) => l.type !== 'same'),
      oldFrontmatter: parseFrontmatter(baseline).data,
      newFrontmatter: parseFrontmatter(current).data,
    };
  }, [payload]);

  if (data.tooLarge || data.lines.length > MAX_RENDERED_LINES) {
    const shown = data.tooLarge ? data.rawLineCount : data.lines.length;
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-muted px-6 text-center">
        Diff is too large to render ({shown.toLocaleString()} lines).
        Accept or reject from the file list.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-white px-4 py-3">
      {data.frontmatterChanged && (
        <FrontmatterDiffPanel
          oldData={data.oldFrontmatter}
          newData={data.newFrontmatter}
        />
      )}
      <DiffPreview blocks={data.bodyBlocks} />
    </div>
  );
}

function countNewlines(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count;
}

// ── frontmatter helpers ─────────────────────────────────────────────────

/**
 * Count how many lines the frontmatter block occupies (including both `---`
 * delimiters) when `content` is split on '\n'. Returns 0 when there is no
 * frontmatter so callers can skip the frontmatter-split logic.
 */
function frontmatterLineCount(content: string): number {
  const lines = content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines[0] !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return i + 1;
  }
  return 0;
}

/**
 * Walk the diff lines, tracking old- and new-line cursors, and split them
 * into the lines that fall inside the frontmatter region and the lines
 * that fall inside the body. `oldFmEnd` / `newFmEnd` are exclusive upper
 * bounds (i.e. the number of frontmatter lines on each side).
 */
function splitDiffByFrontmatter(
  lines: DiffLine[],
  oldFmEnd: number,
  newFmEnd: number,
): { frontmatter: DiffLine[]; body: DiffLine[] } {
  const frontmatter: DiffLine[] = [];
  const body: DiffLine[] = [];
  let oldIdx = 0;
  let newIdx = 0;
  for (const line of lines) {
    const inOldFm = oldIdx < oldFmEnd;
    const inNewFm = newIdx < newFmEnd;
    if (line.type === 'same') {
      if (inOldFm && inNewFm) frontmatter.push(line);
      else body.push(line);
      oldIdx++;
      newIdx++;
    } else if (line.type === 'removed') {
      if (inOldFm) frontmatter.push(line);
      else body.push(line);
      oldIdx++;
    } else {
      if (inNewFm) frontmatter.push(line);
      else body.push(line);
      newIdx++;
    }
  }
  return { frontmatter, body };
}

function FrontmatterDiffPanel({
  oldData,
  newData,
}: {
  oldData: FrontmatterData;
  newData: FrontmatterData;
}) {
  const keys = Array.from(new Set([...Object.keys(oldData), ...Object.keys(newData)]));
  const visible = keys.filter((k) => {
    const o = oldData[k];
    const n = newData[k];
    const oEmpty = o === undefined || (Array.isArray(o) ? o.length === 0 : o === '');
    const nEmpty = n === undefined || (Array.isArray(n) ? n.length === 0 : n === '');
    return !(oEmpty && nEmpty);
  });
  if (visible.length === 0) return null;

  const formatValue = (v: string | string[] | undefined): string => {
    if (v === undefined) return '';
    return Array.isArray(v) ? v.join(', ') : v;
  };

  return (
    <div className="mb-4 rounded-lg border border-line-strong bg-sunken divide-y divide-line">
      {visible.map((key) => {
        const oldVal = formatValue(oldData[key]);
        const newVal = formatValue(newData[key]);
        const changed = oldVal !== newVal;
        return (
          <div key={key} className="flex items-start gap-3 px-3 py-2 text-xs">
            <span className="shrink-0 text-ink-muted w-28">{labelFor(key)}</span>
            {changed ? (
              <div className="flex-1 space-y-1 break-words">
                {oldVal && (
                  <div className="bg-red-100 text-red-700 px-2 py-0.5 rounded-sm">{oldVal}</div>
                )}
                {newVal && (
                  <div className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-sm">{newVal}</div>
                )}
              </div>
            ) : (
              <span className="text-ink break-words">{oldVal}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── body diff helpers ───────────────────────────────────────────────────

/**
 * Group consecutive same/changed runs into display blocks: runs of "same"
 * lines, and "conflict" blocks bundling consecutive removed+added runs
 * together — the same shape git uses for merge conflicts.
 */
type DisplayBlock =
  | { type: 'same'; lines: string[] }
  | { type: 'conflict'; removed: string[]; added: string[] };

function groupDiffBlocks(lines: DiffLine[]): DisplayBlock[] {
  const result: DisplayBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === 'same') {
      const block: DisplayBlock = { type: 'same', lines: [] };
      while (i < lines.length && lines[i].type === 'same') {
        block.lines.push(lines[i].text);
        i++;
      }
      result.push(block);
    } else {
      const block: DisplayBlock = { type: 'conflict', removed: [], added: [] };
      while (i < lines.length && lines[i].type === 'removed') {
        block.removed.push(lines[i].text);
        i++;
      }
      while (i < lines.length && lines[i].type === 'added') {
        block.added.push(lines[i].text);
        i++;
      }
      result.push(block);
    }
  }
  return result;
}

function DiffPreview({ blocks }: { blocks: DisplayBlock[] }) {
  return (
    <div className="prose prose-sm max-w-none">
      {blocks.map((block, i) => {
        if (block.type === 'same') {
          return (
            <Markdown key={i} remarkPlugins={[remarkGfm, remarkFrontmatter]} components={MD_COMPONENTS}>
              {block.lines.join('\n')}
            </Markdown>
          );
        }
        return (
          <div key={i} className="my-2">
            {block.removed.length > 0 && (
              <div className="bg-red-50 border-l-2 border-red-700 px-3 py-1 rounded-sm">
                <Markdown remarkPlugins={[remarkGfm, remarkFrontmatter]} components={MD_COMPONENTS}>
                  {block.removed.join('\n')}
                </Markdown>
              </div>
            )}
            {block.added.length > 0 && (
              <div className="bg-emerald-50 border-l-2 border-emerald-700 px-3 py-1 rounded-sm mt-1">
                <Markdown remarkPlugins={[remarkGfm, remarkFrontmatter]} components={MD_COMPONENTS}>
                  {block.added.join('\n')}
                </Markdown>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
