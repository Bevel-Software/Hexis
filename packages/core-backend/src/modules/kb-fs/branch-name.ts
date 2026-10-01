import { BranchNameError, WorkflowValidationError } from '../../shared/domain-errors.js';

// The protected-branch list is the knowledge base's (`KbContext.protectedBranches`):
// services ask the context they were built with, so the backend guard and the
// frontend banner (which reads the same model from `/api/config`) can't drift.
// Authorship inference lives in `@bevel-software/platform-shared` for the same reason — the
// picker's `canDelete` rule and the backend authorisation check on
// `deleteBranch` must agree on every edge case (uppercase email, dotted
// localpart, etc.).
export {
  branchAuthorLocalpart,
  isBranchAuthoredBy,
  isOwnSuggestionsBranch,
} from '@bevel-software/platform-shared';

const VALID_BRANCH_REGEX = /^[A-Za-z0-9][A-Za-z0-9/_\-.]*$/;

/** Throw if `name` cannot safely be passed to `git` as a branch name. */
export function assertValidBranchName(name: string): void {
  if (!name) throw new BranchNameError('empty name', name);
  if (name.length > 255) throw new BranchNameError('too long', name);
  if (!VALID_BRANCH_REGEX.test(name)) {
    throw new BranchNameError('contains invalid characters', name);
  }
  if (name.includes('..')) throw new BranchNameError('contains ".."', name);
  if (name.includes('//')) throw new BranchNameError('contains "//"', name);
  if (name.endsWith('/') || name.endsWith('.')) {
    throw new BranchNameError('ends with "/" or "."', name);
  }
  if (name.startsWith('-')) throw new BranchNameError('starts with "-"', name);
  if (name.includes('@{')) throw new BranchNameError('contains "@{"', name);
  // Per-segment rules: git forbids any `/`-separated segment from beginning
  // with "." or ending with ".lock" (e.g. `foo/.tmp`, `foo.lock/bar`).
  // The whole-name checks above can't catch nested violations.
  for (const segment of name.split('/')) {
    if (segment.startsWith('.')) {
      throw new BranchNameError('segment starts with "."', name);
    }
    if (segment.endsWith('.lock')) {
      throw new BranchNameError('segment ends with ".lock"', name);
    }
  }
}

/**
 * Guard against path traversal and shell-unsafe characters on any workspace-relative
 * path we pass to `git` as a pathspec. Must stay within the repo; forward slashes only.
 */
export function assertValidRelativePath(relativePath: string): void {
  if (!relativePath) throw new WorkflowValidationError('path is required');
  if (relativePath.length > 1024) throw new WorkflowValidationError('path too long');
  // NUL, every other C0 control and DEL. A NUL is named on its own because it
  // terminates a C string and git's `-z` output; the rest are refused with it
  // because a LINE BREAK in a path is a separator in git's line-oriented stdin
  // protocols — `cat-file --batch` reads one `<ref>:<path>` per line, so
  // `Docs/secret.md\nzzz` is two object names while every gate upstream was
  // asked about one string. See `CONTROL_CHARACTERS` in `repo-path.ts`, which
  // refuses the same range at the normaliser; this is the same rule at the
  // check every path handed to git as a pathspec passes through.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(relativePath)) {
    throw new WorkflowValidationError(
      relativePath.includes('\0') ? 'path contains NUL' : 'path contains a control character',
    );
  }
  if (relativePath.includes('\\')) {
    throw new WorkflowValidationError('path must use forward slashes only');
  }
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
    throw new WorkflowValidationError('path must be relative');
  }
  const parts = relativePath.split('/');
  if (parts.some((p) => p === '..' || p === '.')) {
    throw new WorkflowValidationError('path must not contain "." or ".."');
  }
  if (relativePath.startsWith('-')) {
    throw new WorkflowValidationError('path must not start with "-"');
  }
  // Pathspec glob characters (`*`, `?`, `[`, `]`, `!`) and pathspec magic (`:(…)`)
  // would otherwise be interpreted by `git add -- <path>` / `git log -- <path>`
  // and match the wrong files. `GitService.git()` sets `GIT_LITERAL_PATHSPECS=1`
  // on every git subprocess, which forces literal interpretation across the
  // board — so KB filenames containing `[Approved]`, `[New]`, etc. round-trip
  // through commit cleanly. The shared `validateFilename` already rejects `:`
  // along with the rest of Windows-forbidden characters before paths reach this
  // layer, so a redundant check here would only confuse the error message.
}
