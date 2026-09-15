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
    // An UNRESOLVED spelling that lands inside. Concatenated, not joined:
    // `path.join` would collapse the `..` before the guard ever saw it, and
    // resolving the caller's spelling is the guard's own job.
    ok(`${root}${path.sep}a${path.sep}..${path.sep}b.md`);
    ok(`${root}${path.sep}`);
  });

  it('refuses a climb out, a sibling, and the parent', () => {
    // Unresolved again: this is the spelling an attacker actually sends.
    refused(`${root}${path.sep}..${path.sep}other${path.sep}secrets.md`);
    refused(`${root}${path.sep}a${path.sep}..${path.sep}..${path.sep}escape.md`);
    refused(path.dirname(root));
    // A sibling whose name merely STARTS with the root's — the prefix trap a
    // `startsWith(root)` check without the separator falls into.
    refused(`${root}-backup`);
    refused(`${root}-backup${path.sep}notes.md`);
  });

  it('admits descendants of the filesystem root, which already ends in a separator', () => {
    // `root + sep` would be `//` (or `C:\\`), which no descendant starts
    // with — so a doubled separator refuses every path under it.
    const fsRoot = path.parse(path.resolve('/')).root;
    expect(() => assertWithinDirectory(path.join(fsRoot, 'etc', 'passwd'), fsRoot)).not.toThrow();
    expect(() => assertWithinDirectory(fsRoot, fsRoot)).not.toThrow();
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
