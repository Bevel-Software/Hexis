import { useMemo } from 'react';
import Markdown from 'react-markdown';
import type { FileDiffPayload } from '@bevel-software/platform-shared';
import { computeDiff, type DiffLine } from '../../workspace/utils/diff';
import { parseFrontmatter, labelFor, type FrontmatterData } from '../../workspace/utils/frontmatter';
import { escapeSpacesInLinkDestinations } from '../../../shared/markdown/Markdown';
import {
  KB_REMARK_PLUGINS,
  KB_DIFF_REHYPE_PLUGINS,
  useKbMarkdownComponents,
} from '../../workspace/components/renderers/kbMarkdownPipeline';

const MAX_RENDERED_LINES = 5000;

interface MarkdownDiffViewerProps {
  payload: FileDiffPayload;
  /**
   * Resolver for an internal `.md` link inside the diff. Omitted → such links
   * render as inert anchors, which is the right default for a view of a PAST
   * state: the file history panel shows a commit, and there is no meaningful
   * "current" document for a relative link to resolve against.
   *
   * A caller that DOES pass one must bind it to the branch the diff is OF —
   * the change request's branch, not whatever branch is checked out. The
   * navigation hooks in `kb-routes` resolve against `git.status.branch`, so
   * handing them through unbound would silently send a reviewer to a different
   * branch's copy of the file they just clicked.
   */
  onOpenFile?: (href: string) => void;
  /** Same contract as {@link onOpenFile}, for bare node-id links. */
  onOpenNodeId?: (id: string) => void;
  /**
   * Whether this view owns a scroller and its own padding. `true` (the
   * default) keeps the self-contained box the change-request dialog and the
   * file-history panel rely on.
   *
   * Pass `false` when the PARENT is the scroller. The review panel is: a
   * centred column whose CHILD scrolls leaves the gutters either side outside
   * the scroll hit area, so the wheel does nothing over them. Making the
   * panel-width parent scroll and putting the measure on an inner container
   * fixes that — but only if this stops owning `overflow-auto`, since two
   * nested `h-full overflow-auto` boxes leave the outer one unable to scroll
   * and stack both paddings.
   *
   * Mirrors `KbMarkdownView.scroll`, for the same reason and with the same
   * default.
   */
  scroll?: boolean;
}

/**
 * Frontmatter-aware diff renderer for markdown files. Splits the diff into
 * frontmatter and body regions; renders the frontmatter as a structured
 * key-by-key red/green panel (rather than raw `key: value` lines), and the
 * body as either a markdown-rendered preview with red/green change blocks or
 * a git-conflict-marker view for side-by-side text inspection.
 *
 * The body renders through the shared KB markdown pipeline
 * (`kbMarkdownPipeline`), so a diff reads like the document it is a diff of:
 * id-links, `<details>` blocks and mermaid diagrams behave as they do in the
 * knowledge view rather than as raw text.
 *
 * Resolvers arrive as PROPS and no hook is called here. That is deliberate:
 * this component renders inside the change-request dialog and the file-history
 * panel, both of which are mounted in places (and tested in ways) that have no
 * Router and no Git/Workspace context — and it is reachable from the embed
 * routes, which sit outside those providers entirely. A `useNavigate()` in
 * here would be a runtime crash in all three.
 */
export function MarkdownDiffViewer({ payload, onOpenFile, onOpenNodeId, scroll = true }: MarkdownDiffViewerProps) {
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
    <div className={scroll ? 'h-full overflow-auto bg-white px-4 py-3' : 'min-w-0'}>
      {data.frontmatterChanged && (
        <FrontmatterDiffPanel
          oldData={data.oldFrontmatter}
          newData={data.newFrontmatter}
        />
      )}
      <DiffPreview
        blocks={data.bodyBlocks}
        onOpenFile={onOpenFile}
        onOpenNodeId={onOpenNodeId}
      />
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
 * Plugin consecutive same/changed runs into display blocks: runs of "same"
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

function DiffPreview({
  blocks,
  onOpenFile,
  onOpenNodeId,
}: {
  blocks: DisplayBlock[];
  onOpenFile?: (href: string) => void;
  onOpenNodeId?: (id: string) => void;
}) {
  // `'source'`: a diagram whose ```mermaid fence straddles a change boundary
  // reaches the renderer truncated and cannot parse, so the error box would
  // replace the red/green source — the only useful content in that block — on
  // every EDITED diagram. Untouched ones sit whole inside a single unchanged
  // fragment and still render as diagrams.
  //
  // No `headingLink`: a diff shows no copy-anchor buttons, and the slug ids
  // they depend on are deliberately absent (see KB_DIFF_REHYPE_PLUGINS).
  const components = useKbMarkdownComponents({
    onOpenFile,
    onOpenNodeId,
    onMermaidError: 'source',
  });

  // Each block is parsed as a standalone document, so the space-escaping that
  // makes `[Foo](Some File.md)` resolve has to be applied per fragment.
  const fragment = (text: string) => (
    <Markdown
      remarkPlugins={KB_REMARK_PLUGINS}
      rehypePlugins={KB_DIFF_REHYPE_PLUGINS}
      components={components}
    >
      {escapeSpacesInLinkDestinations(text)}
    </Markdown>
  );

  return (
    <div className="prose prose-sm max-w-none">
      {blocks.map((block, i) => {
        if (block.type === 'same') {
          return <div key={i}>{fragment(block.lines.join('\n'))}</div>;
        }
        return (
          <div key={i} className="my-2">
            {block.removed.length > 0 && (
              <div className="bg-red-50 border-l-2 border-red-700 px-3 py-1 rounded-sm">
                {fragment(block.removed.join('\n'))}
              </div>
            )}
            {block.added.length > 0 && (
              <div className="bg-emerald-50 border-l-2 border-emerald-700 px-3 py-1 rounded-sm mt-1">
                {fragment(block.added.join('\n'))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
