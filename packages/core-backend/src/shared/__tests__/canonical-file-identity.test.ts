import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { assertValidRelativePath } from '@bevel-software/platform-shared';
import { canonicalFileIdentity } from '../canonical-file-identity.js';
import { PathTraversalError, WorkflowValidationError } from '../domain-errors.js';

/**
 * Two properties, and the second is the one worth the file.
 *
 * 1. Spellings of one file collapse to one string.
 * 2. A path the canonicaliser refuses gets the SAME answer the file verbs
 *    give for that input. The lock routes and `PUT /file` name the same
 *    file and take the same lock, so answering differently would mean a path
 *    the editor cannot save to is nonetheless lockable, or the reverse.
 *
 * The oracle for (2) is not a hand-written status table. It runs the guard
 * pair `WorkspaceService.withPathTurn` runs, in its order: the shared
 * `assertValidRelativePath`, whose `Invalid path: ...` message
 * `workspace.routes.sendError` maps to 400, then resolution against the
 * workspace directory, whose `Path traversal detected`
 * `sendError` maps to 403. The validator is the real one, imported, so a
 * change to what it accepts moves both sides of the comparison at once.
 */

const WORKSPACE_DIR = path.resolve('/srv/workspaces/feat%2Fx');

/** The status `PUT /file` answers for `candidate`, or 0 when it accepts it. */
function fileVerbStatus(candidate: string): number {
  try {
    assertValidRelativePath(candidate);
  } catch {
    return 400; // `sendError`: a message starting with "Invalid path".
  }
  // `WorkspaceService.assertWithinWorkspace`, verbatim.
  const resolved = path.resolve(WORKSPACE_DIR, candidate);
  if (!resolved.startsWith(WORKSPACE_DIR + path.sep) && resolved !== WORKSPACE_DIR) {
    return 403; // `sendError`: the message "Path traversal detected".
  }
  return 0;
}

/** The status the lock surface answers for `candidate`, or 0 when accepted. */
function lockStatus(candidate: string): number {
  try {
    canonicalFileIdentity(candidate);
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
}

const ONE_FILE = 'knowledge-base/x/a.md';

describe('canonicalFileIdentity', () => {
  it.each([
    ONE_FILE,
    `./${ONE_FILE}`,
    'knowledge-base//x/a.md',
    './knowledge-base//x//a.md',
    'knowledge-base/x//a.md',
  ])('reads %s as one file', (spelling) => {
    expect(canonicalFileIdentity(spelling)).toBe(ONE_FILE);
  });

  it('is idempotent', () => {
    const once = canonicalFileIdentity('./knowledge-base//x//a.md');
    expect(canonicalFileIdentity(once)).toBe(once);
  });

  it('leaves case alone: on Linux Foo.md and foo.md are two files', () => {
    expect(canonicalFileIdentity('knowledge-base/Foo.md')).toBe('knowledge-base/Foo.md');
    expect(canonicalFileIdentity('knowledge-base/Foo.md')).not.toBe(
      canonicalFileIdentity('knowledge-base/foo.md'),
    );
  });

  it('refuses a path that climbs out rather than resolving it away', () => {
    expect(() => canonicalFileIdentity('../etc/passwd')).toThrow(WorkflowValidationError);
    expect(() => canonicalFileIdentity('knowledge-base/../../etc/passwd')).toThrow(
      WorkflowValidationError,
    );
  });

  it('refuses a climb that would land back inside, instead of laundering it', () => {
    // `knowledge-base/x/../y.md` resolves inside the workspace, so a
    // containment check alone would wave it through under a second identity
    // for `knowledge-base/y.md`.
    expect(() => canonicalFileIdentity('knowledge-base/x/../y.md')).toThrow(
      WorkflowValidationError,
    );
  });

  it('refuses an absolute path as traversal, not as a relative one', () => {
    // Dropping the empty leading segment would turn `/etc/passwd` into the
    // perfectly ordinary `etc/passwd`, which is exactly the laundering
    // `canonicalRelativePath` declines to do.
    expect(() => canonicalFileIdentity('/etc/passwd')).toThrow(PathTraversalError);
  });

  it('refuses an absolute path that the containment stand-in would call contained', () => {
    // The trap the stand-in root sets for itself: `validateRelativePath`
    // accepts `/workspace/a.md`, and resolving it against `/workspace`
    // lands it inside `/workspace` — so containment alone reads it as fine
    // and it becomes a lock identity. No real workspace directory is ever
    // literally `/workspace` (it is `<workspacesRoot>/<id>`), so the file
    // verbs resolve that same path outside their workspace and answer 403.
    expect(() => canonicalFileIdentity('/workspace/a.md')).toThrow(PathTraversalError);
    expect(() => canonicalFileIdentity('/workspace')).toThrow(PathTraversalError);
  });

  it('refuses a non-string path as the client mistake it is, not as a 500', () => {
    // The routes' guard only tests falsiness, so `{"path": 123}` reaches
    // here. Unguarded, `canonicalRelativePath` calls `.startsWith` on a
    // number and the bare `TypeError` becomes a 500; `PUT /file` answers
    // 400 for that same body.
    for (const notAPath of [123, true, {}, [], ['a.md'], null, undefined]) {
      expect(() => canonicalFileIdentity(notAPath as unknown as string)).toThrow(
        WorkflowValidationError,
      );
      expect(() => canonicalFileIdentity(notAPath as unknown as string)).toThrow(
        'Invalid path: Path is required',
      );
    }
  });

  const INPUTS = [
    ONE_FILE,
    `./${ONE_FILE}`,
    'knowledge-base//x/a.md',
    'knowledge-base/Some [Approved] Node.md',
    '../etc/passwd',
    '../../etc/passwd',
    'knowledge-base/../../etc/passwd',
    'knowledge-base/x/../y.md',
    './..',
    '..',
    '.',
    './',
    '/etc/passwd',
    // Absolute, but spelled to look contained under the stand-in root the
    // implementation resolves against.
    '/workspace/a.md',
    '/workspace',
    '/workspace/',
    '/',
    'knowledge-base\\x\\a.md',
    'C:/Windows/system32',
    '',
  ];

  it.each(INPUTS)('answers %j with the status the file verbs answer', (input) => {
    expect(lockStatus(input)).toBe(fileVerbStatus(input));
  });
});
