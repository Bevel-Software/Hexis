import { useMemo, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { PrReviewComment, PullRequestFile } from '@bevel-software/platform-shared';
import { parsePatch } from '../utils/parsePatch';
import { bucketizeComments, type ThreadBucket } from '../utils/bucketize-comments';
import { PrCommentThread } from './PrCommentThread';
import { PrCommentComposer } from './PrCommentComposer';

interface Props {
  file: PullRequestFile | null;
  /**
   * All comments that anchor to a line of this file (i.e. `path === file.path`
   * and `line !== undefined`). Parent filtering + bucketing happens inside.
   */
  lineComments: PrReviewComment[];
  currentUserEmail: string;
  currentHeadSha: string;
  /** Called for a brand-new top-level comment on `line` (new-file line number). */
  onPostLineComment(line: number, body: string): Promise<void>;
  onReplyComment(parentId: string, body: string): Promise<void>;
  onEditComment(commentId: string, body: string): Promise<void>;
  onDeleteComment(commentId: string): Promise<void>;
}

const MAX_RENDERED_LINES = 5000;

type DiffRowKind = 'same' | 'added' | 'removed';

interface DiffRow {
  kind: DiffRowKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
  /** Stable key within the pane — used as the table-row key. */
  key: string;
}

interface HunkGroup {
  header: string;
  rows: DiffRow[];
}

/**
 * Flatten hunks into typed rows with pre-resolved line numbers. Done up front so
 * the render pass is pure mapping — no more mutable counters threaded through
 * closures, and the (path, line) → thread lookup needs the resolved `newLine`.
 */
function flattenHunks(file: PullRequestFile): HunkGroup[] {
  const hunks = parsePatch(file.patch);
  return hunks.map((hunk, hIdx) => {
    const rows: DiffRow[] = [];
    let oldLine = hunk.oldStart - 1;
    let newLine = hunk.newStart - 1;
    hunk.lines.forEach((l, i) => {
      if (l.type === 'same') {
        oldLine++;
        newLine++;
        rows.push({ kind: 'same', text: l.text, oldLine, newLine, key: `${hIdx}:${i}` });
      } else if (l.type === 'added') {
        newLine++;
        rows.push({ kind: 'added', text: l.text, oldLine: null, newLine, key: `${hIdx}:${i}` });
      } else {
        oldLine++;
        rows.push({ kind: 'removed', text: l.text, oldLine, newLine: null, key: `${hIdx}:${i}` });
      }
    });
    return { header: hunk.header, rows };
  });
}

export function PrDiffPane({
  file,
  lineComments,
  currentUserEmail,
  currentHeadSha,
  onPostLineComment,
  onReplyComment,
  onEditComment,
  onDeleteComment,
}: Props) {
  // One composer active at a time. Storing the new-file line number as the
  // discriminator matches how the comment is stored in the DB.
  const [activeComposerLine, setActiveComposerLine] = useState<number | null>(null);

  const groups = useMemo<HunkGroup[]>(
    () => (file && !file.isBinary && file.patch ? flattenHunks(file) : []),
    [file],
  );

  // Partition inline comments by the new-file line they anchor to. Comments
  // whose anchor line doesn't exist in the current patch (stale pins after a
  // force-push / after new commits) go into `orphaned` — rendered below the
  // diff as a collapsed block so the discussion doesn't vanish.
  const { threadsByLine, orphanedThreads } = useMemo(() => {
    const linesInDiff = new Set<number>();
    for (const g of groups) {
      for (const r of g.rows) {
        if (r.newLine !== null) linesInDiff.add(r.newLine);
      }
    }
    const threadsByLine = new Map<number, ThreadBucket[]>();
    const orphaned: ThreadBucket[] = [];
    const buckets = bucketizeComments(lineComments);
    for (const b of buckets) {
      const line = b.root.line;
      if (line === undefined) continue;
      if (linesInDiff.has(line)) {
        const list = threadsByLine.get(line) ?? [];
        list.push(b);
        threadsByLine.set(line, list);
      } else {
        orphaned.push(b);
      }
    }
    return { threadsByLine, orphanedThreads: orphaned };
  }, [groups, lineComments]);

  const totalLines = useMemo(
    () => groups.reduce((sum, g) => sum + g.rows.length, 0),
    [groups],
  );

  if (!file) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-muted">
        Select a file to see what changed.
      </div>
    );
  }

  if (file.isBinary) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-ink-muted text-xs px-6 text-center">
        <div className="font-medium text-ink">Binary file — preview not available</div>
        <div className="font-mono truncate max-w-full" title={file.path}>{file.path}</div>
      </div>
    );
  }

  if (!file.patch) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-muted px-6 text-center">
        Can't show what changed inline (file is too large).
      </div>
    );
  }

  if (totalLines > MAX_RENDERED_LINES) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-muted px-6 text-center">
        Too many changes to show inline ({totalLines.toLocaleString()} lines).
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-white font-mono text-[12px] leading-[18px]">
      <table className="w-full border-collapse">
        <tbody>
          {groups.map((group, gIdx) => (
            <HunkRows
              key={gIdx}
              group={group}
              threadsByLine={threadsByLine}
              activeComposerLine={activeComposerLine}
              currentUserEmail={currentUserEmail}
              currentHeadSha={currentHeadSha}
              onAddComment={(line) => setActiveComposerLine(line)}
              onCancelComposer={() => setActiveComposerLine(null)}
              onSubmitComposer={async (line, body) => {
                await onPostLineComment(line, body);
                setActiveComposerLine(null);
              }}
              onReplyComment={onReplyComment}
              onEditComment={onEditComment}
              onDeleteComment={onDeleteComment}
            />
          ))}
        </tbody>
      </table>

      {orphanedThreads.length > 0 && (
        <OrphanedInlineThreads
          threads={orphanedThreads}
          currentUserEmail={currentUserEmail}
          currentHeadSha={currentHeadSha}
          onReplyComment={onReplyComment}
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
        />
      )}
    </div>
  );
}

/**
 * Render one hunk's rows plus any inline threads / open composer that
 * attaches to each line. Nested as its own component so the top-level pane
 * stays a straightforward `groups.map(...)`.
 */
function HunkRows({
  group,
  threadsByLine,
  activeComposerLine,
  currentUserEmail,
  currentHeadSha,
  onAddComment,
  onCancelComposer,
  onSubmitComposer,
  onReplyComment,
  onEditComment,
  onDeleteComment,
}: {
  group: HunkGroup;
  threadsByLine: Map<number, ThreadBucket[]>;
  activeComposerLine: number | null;
  currentUserEmail: string;
  currentHeadSha: string;
  onAddComment(line: number): void;
  onCancelComposer(): void;
  onSubmitComposer(line: number, body: string): Promise<void>;
  onReplyComment(parentId: string, body: string): Promise<void>;
  onEditComment(commentId: string, body: string): Promise<void>;
  onDeleteComment(commentId: string): Promise<void>;
}) {
  return (
    <>
      <tr className="bg-white border-y border-line">
        <td colSpan={4} className="px-3 py-1 text-[11px] text-ink-muted font-mono">
          {group.header}
        </td>
      </tr>
      {group.rows.map((row) => {
        const threads =
          row.newLine !== null ? threadsByLine.get(row.newLine) ?? [] : [];
        const composerOpen =
          row.newLine !== null && activeComposerLine === row.newLine;
        // Only added + same rows can anchor NEW comments (DB stores the new-
        // file line number). Removed rows render inline threads only when some
        // pre-removal comment happens to have matched — unlikely but harmless.
        const canComment = row.newLine !== null;
        return (
          <DiffLineAndThreads
            key={row.key}
            row={row}
            threads={threads}
            composerOpen={composerOpen}
            canComment={canComment}
            currentUserEmail={currentUserEmail}
            currentHeadSha={currentHeadSha}
            onAddComment={() => row.newLine !== null && onAddComment(row.newLine)}
            onCancelComposer={onCancelComposer}
            onSubmitComposer={(body) =>
              row.newLine !== null ? onSubmitComposer(row.newLine, body) : Promise.resolve()
            }
            onReplyComment={onReplyComment}
            onEditComment={onEditComment}
            onDeleteComment={onDeleteComment}
          />
        );
      })}
    </>
  );
}

function DiffLineAndThreads({
  row,
  threads,
  composerOpen,
  canComment,
  currentUserEmail,
  currentHeadSha,
  onAddComment,
  onCancelComposer,
  onSubmitComposer,
  onReplyComment,
  onEditComment,
  onDeleteComment,
}: {
  row: DiffRow;
  threads: ThreadBucket[];
  composerOpen: boolean;
  canComment: boolean;
  currentUserEmail: string;
  currentHeadSha: string;
  onAddComment(): void;
  onCancelComposer(): void;
  onSubmitComposer(body: string): Promise<void>;
  onReplyComment(parentId: string, body: string): Promise<void>;
  onEditComment(commentId: string, body: string): Promise<void>;
  onDeleteComment(commentId: string): Promise<void>;
}) {
  const bg = row.kind === 'added'
    ? 'bg-emerald-100'
    : row.kind === 'removed'
      ? 'bg-red-100'
      : '';
  const textColor = row.kind === 'added'
    ? 'text-emerald-700'
    : row.kind === 'removed'
      ? 'text-red-700'
      : 'text-ink';
  const marker = row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' ';

  return (
    <>
      <tr className={`group ${bg}`}>
        <td className="w-12 text-right pr-2 text-ink-muted select-none border-r border-line relative">
          {row.oldLine ?? ''}
        </td>
        <td className="w-12 text-right pr-2 text-ink-muted select-none border-r border-line relative">
          {/* Hover affordance for adding a line comment. Anchored to the new-
              line gutter so it only appears on rows the comment model supports. */}
          {canComment && (
            <button
              type="button"
              onClick={onAddComment}
              title="Add a comment on this line"
              className="absolute -left-1 top-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center w-4 h-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded shadow-sm"
              tabIndex={-1}
            >
              <MessageSquarePlus size={10} />
            </button>
          )}
          {row.newLine ?? ''}
        </td>
        <td className={`w-4 text-center ${textColor} select-none`}>{marker}</td>
        <td className={`whitespace-pre-wrap break-words pl-2 pr-3 ${textColor}`}>
          {row.text || '\u00A0'}
        </td>
      </tr>

      {/* Existing threads on this line. One row per bucket — full table width. */}
      {threads.map((bucket) => (
        <tr key={bucket.root.id} className="bg-white">
          <td colSpan={4} className="px-3 py-2 border-y border-line">
            <div className="text-[12px]">
              <PrCommentThread
                root={bucket.root}
                replies={bucket.replies}
                currentUserEmail={currentUserEmail}
                isStale={bucket.root.headSha !== currentHeadSha}
                onPostReply={onReplyComment}
                onEdit={onEditComment}
                onDelete={onDeleteComment}
              />
            </div>
          </td>
        </tr>
      ))}

      {composerOpen && (
        <tr className="bg-white">
          <td colSpan={4} className="px-3 py-2 border-y border-line">
            <div className="text-[12px] flex flex-col gap-1.5">
              <div className="text-[10px] uppercase tracking-wider text-ink-muted">
                Comment on line {row.newLine}
              </div>
              <PrCommentComposer
                placeholder="Leave a comment on this line…"
                submitLabel="Comment"
                autoFocus
                onSubmit={onSubmitComposer}
                onCancel={onCancelComposer}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Fallback render for inline threads whose anchor line doesn't exist in the
 * current patch — typically after a force-push dropped the line or the file
 * was rewritten. Collapsed by default; the "outdated" banner on each thread
 * carries the explanation.
 */
function OrphanedInlineThreads({
  threads,
  currentUserEmail,
  currentHeadSha,
  onReplyComment,
  onEditComment,
  onDeleteComment,
}: {
  threads: ThreadBucket[];
  currentUserEmail: string;
  currentHeadSha: string;
  onReplyComment(parentId: string, body: string): Promise<void>;
  onEditComment(commentId: string, body: string): Promise<void>;
  onDeleteComment(commentId: string): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-t border-line bg-white/40 px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-[11px] text-amber-700 hover:text-amber-900 flex items-center gap-1.5"
      >
        {expanded ? '▾' : '▸'} {threads.length} outdated inline comment
        {threads.length === 1 ? '' : 's'} (
        {threads.length === 1 ? 'this line no longer exists' : 'these lines no longer exist'})
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {threads.map((bucket) => (
            <PrCommentThread
              key={bucket.root.id}
              root={bucket.root}
              replies={bucket.replies}
              currentUserEmail={currentUserEmail}
              isStale={bucket.root.headSha !== currentHeadSha}
              onPostReply={onReplyComment}
              onEdit={onEditComment}
              onDelete={onDeleteComment}
            />
          ))}
        </div>
      )}
    </div>
  );
}
