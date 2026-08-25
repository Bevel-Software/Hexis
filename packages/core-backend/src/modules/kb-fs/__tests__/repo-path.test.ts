import { describe, it, expect } from 'vitest';
import { assertInsideRepo, isInsideRepo } from '../repo-path.js';
import { WorkflowValidationError } from '../../../shared/domain-errors.js';

const KB = 'knowledge-base';

describe('isInsideRepo', () => {
  it('accepts the repository folder and anything under it', () => {
    expect(isInsideRepo('knowledge-base', KB)).toBe(true);
    expect(isInsideRepo('knowledge-base/KnowledgeBase/Foo.md', KB)).toBe(true);
    expect(isInsideRepo('knowledge-base/roles.yaml', KB)).toBe(true);
  });

  it('refuses a repo-relative path: it would land beside the repository, where git never looks', () => {
    expect(isInsideRepo('KnowledgeBase/Reviews/PR-12.html', KB)).toBe(false);
    expect(isInsideRepo('review.log', KB)).toBe(false);
    expect(isInsideRepo('tmp/spill.txt', KB)).toBe(false);
  });

  it('matches the folder as a whole segment, not as a string prefix', () => {
    expect(isInsideRepo('knowledge-based/x.md', KB)).toBe(false);
    expect(isInsideRepo('knowledge-base-old/x.md', KB)).toBe(false);
    expect(isInsideRepo('knowledge-base.bak', KB)).toBe(false);
  });

  it('refuses traversal that starts under the prefix and climbs back out', () => {
    // `knowledge-base/../stray.md` starts with the clone folder but resolves
    // beside it: the containment check is against the WORKSPACE dir, so the
    // filesystem would accept it and the bytes would land outside git.
    expect(isInsideRepo('knowledge-base/../stray.md', KB)).toBe(false);
    expect(isInsideRepo('knowledge-base/KnowledgeBase/../../stray.md', KB)).toBe(false);
    expect(isInsideRepo('knowledge-base/./x.md', KB)).toBe(false);
    expect(isInsideRepo('knowledge-base//x.md', KB)).toBe(false);
  });

  it('refuses backslashes anywhere: on Windows they separate segments too, and the commit layer rejects them', () => {
    expect(isInsideRepo('knowledge-base/foo\\..\\..\\outside.md', KB)).toBe(false);
    expect(isInsideRepo('knowledge-base\\KnowledgeBase\\x.md', KB)).toBe(false);
    expect(isInsideRepo('knowledge-base/KnowledgeBase/a\\b.md', KB)).toBe(false);
  });

  it('tolerates a trailing slash on a directory path', () => {
    expect(isInsideRepo('knowledge-base/', KB)).toBe(true);
    expect(isInsideRepo('knowledge-base/KnowledgeBase/Projects/', KB)).toBe(true);
  });

  it('refuses dressed-up forms of the prefix that the commit layer would reject anyway', () => {
    expect(isInsideRepo('./knowledge-base/x.md', KB)).toBe(false);
    expect(isInsideRepo('/knowledge-base/x.md', KB)).toBe(false);
    expect(isInsideRepo('', KB)).toBe(false);
  });
});

describe('assertInsideRepo', () => {
  it('passes silently for a path inside the repository', () => {
    expect(() => assertInsideRepo('knowledge-base/KnowledgeBase/Foo.md', KB)).not.toThrow();
  });

  it('throws a 400 that names the prefix and spells out the corrected path', () => {
    let err: unknown;
    try {
      assertInsideRepo('KnowledgeBase/Reviews/PR-12.html', KB);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkflowValidationError);
    const e = err as WorkflowValidationError;
    expect(e.status).toBe(400);
    // The offending path, the rule, and the exact path to use instead: an
    // agent reading this error can retry without guessing.
    expect(e.message).toContain('"KnowledgeBase/Reviews/PR-12.html"');
    expect(e.message).toContain('"knowledge-base/"');
    expect(e.message).toContain('"knowledge-base/KnowledgeBase/Reviews/PR-12.html"');
    expect(e.payload).toMatchObject({
      kind: 'path-outside-repo',
      path: 'KnowledgeBase/Reviews/PR-12.html',
      kbDirName: KB,
    });
  });

  it('suggests the path with the traversal collapsed, back under the prefix', () => {
    expect(() => assertInsideRepo('knowledge-base/../stray.md', KB)).toThrow('"knowledge-base/stray.md"');
    expect(() => assertInsideRepo('knowledge-base/../../escape.md', KB)).toThrow('"knowledge-base/escape.md"');
  });

  it('suggests a forward-slash path for a backslash one', () => {
    expect(() => assertInsideRepo('knowledge-base/foo\\..\\..\\outside.md', KB)).toThrow('"knowledge-base/outside.md"');
    expect(() => assertInsideRepo('KnowledgeBase\\Reviews\\PR-12.html', KB)).toThrow('"knowledge-base/KnowledgeBase/Reviews/PR-12.html"');
  });

  it('never suggests a path that still climbs: a bare `..` corrects to the repository folder', () => {
    for (const p of ['..', '../', '../..', '../../', 'knowledge-base/..']) {
      let message = '';
      try {
        assertInsideRepo(p, KB);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, p).toContain('Use "knowledge-base/" instead');
      expect(message, p).not.toMatch(/Use "[^"]*\.\.[^"]*" instead/);
    }
  });
});
