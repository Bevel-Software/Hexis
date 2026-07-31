import type { DiffLine } from '../../workspace/utils/diff';

export interface PatchHunk {
  /** 1-based starting line number in the old file. */
  oldStart: number;
  /** 1-based starting line number in the new file. */
  newStart: number;
  header: string;   // the raw `@@ -1,3 +1,4 @@ …` line, for tooltip/debug
  lines: DiffLine[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a GitHub unified-diff patch into hunks. Handles the standard lead
 * characters: ` ` (same), `+` (added), `-` (removed), `\` (no-newline marker,
 * which we ignore — the adjacent line already captured the content).
 *
 * Returns an empty array for empty/missing patches so callers can uniformly
 * render "no inline diff available" for binary and oversized files.
 */
export function parsePatch(patch: string | undefined): PatchHunk[] {
  if (!patch) return [];
  const out: PatchHunk[] = [];
  let current: PatchHunk | null = null;

  for (const raw of patch.split('\n')) {
    const match = HUNK_HEADER_RE.exec(raw);
    if (match) {
      if (current) out.push(current);
      current = {
        oldStart: parseInt(match[1], 10) || 1,
        newStart: parseInt(match[2], 10) || 1,
        header: raw,
        lines: [],
      };
      continue;
    }
    if (!current) continue;  // ignore any preamble before the first hunk
    if (raw.startsWith('\\')) continue;  // "\ No newline at end of file"

    if (raw.startsWith('+')) {
      current.lines.push({ type: 'added', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      current.lines.push({ type: 'removed', text: raw.slice(1) });
    } else if (raw.startsWith(' ')) {
      current.lines.push({ type: 'same', text: raw.slice(1) });
    } else if (raw === '') {
      // Empty line in the middle of a hunk — patch format uses an unprefixed
      // empty line as a context line. Preserve it.
      current.lines.push({ type: 'same', text: '' });
    }
    // Anything else is noise (trailing junk) — skip.
  }
  if (current) out.push(current);
  return out;
}
