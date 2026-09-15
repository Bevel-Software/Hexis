import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { assertWithinDirectory } from '../path-containment.js';
import { PathTraversalError } from '../domain-errors.js';

/**
 * The one lexical containment check: what it admits, what it refuses, and
 * — the property the route layers depend on — that its refusal is a TYPE
 * carrying its own status, not a message anyone has to recognise.
 */
describe('assertWithinDirectory', () => {
  const root = path.resolve('/srv/workspaces/main');
  const ok = (p: string) => expect(() => assertWithinDirectory(p, root)).not.toThrow();
  const refused = (p: string) => expect(() => assertWithinDirectory(p, root)).toThrow(PathTraversalError);

  it('admits the directory itself and anything under it, however spelled', () => {
    ok(root);
    ok(path.join(root, 'knowledge-base', 'notes.md'));
    // Unresolved spellings that still land inside.
    ok(path.join(root, 'a', '..', 'b.md'));
    ok(`${root}${path.sep}`);
  });

  it('refuses a climb out, a sibling, and the parent', () => {
    refused(path.join(root, '..', 'other', 'secrets.md'));
    refused(path.dirname(root));
    // A sibling whose name merely STARTS with the root's — the prefix trap a
    // `startsWith(root)` check without the separator falls into.
    refused(`${root}-backup`);
    refused(`${root}-backup${path.sep}notes.md`);
  });

  it('refuses an absolute path somewhere else entirely', () => {
    refused(path.resolve('/etc/passwd'));
    refused(path.resolve('/srv/workspaces/other/notes.md'));
  });

  it('refuses with a 403 domain error the routes read the status off, not a message they must match', () => {
    let thrown: unknown;
    try {
      assertWithinDirectory(path.join(root, '..', 'escape'), root);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PathTraversalError);
    expect(thrown).toMatchObject({ status: 403, payload: { kind: 'path-traversal' } });
  });
});
