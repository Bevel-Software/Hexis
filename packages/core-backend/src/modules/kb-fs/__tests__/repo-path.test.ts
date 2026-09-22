import { describe, it, expect } from 'vitest';
import {
  assertInsideRepo,
  assertKbDirNameFree,
  assertRepoRootNameFree,
  assertRepoRootNameFreeArgs,
  isInsideRepo,
  normalizePathArgs,
  normalizeWorkspacePath,
} from '../repo-path.js';
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
      // On its own as well: the pending-commits worker's notice reads it from
      // here, because the message it keeps is truncated.
      corrected: 'knowledge-base/KnowledgeBase/Reviews/PR-12.html',
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

describe('normalizeWorkspacePath — THE normaliser', () => {
  it('leaves a path that is already inside the repository alone', () => {
    expect(normalizeWorkspacePath('knowledge-base/KnowledgeBase/Foo.md', KB)).toBe('knowledge-base/KnowledgeBase/Foo.md');
    expect(normalizeWorkspacePath('knowledge-base', KB)).toBe('knowledge-base');
    expect(normalizeWorkspacePath('knowledge-base/KnowledgeBase/Projects/', KB)).toBe('knowledge-base/KnowledgeBase/Projects/');
  });

  it('places an unprefixed path under the repository folder', () => {
    expect(normalizeWorkspacePath('KnowledgeBase/Foo.md', KB)).toBe('knowledge-base/KnowledgeBase/Foo.md');
    expect(normalizeWorkspacePath('TestDocx.docx', KB)).toBe('knowledge-base/TestDocx.docx');
    expect(normalizeWorkspacePath('Plugins/GTM/tools.json', KB)).toBe('knowledge-base/Plugins/GTM/tools.json');
    // The one that made the folder on core-staging.
    expect(normalizeWorkspacePath('KnowledgeBase/Reports', KB)).toBe('knowledge-base/KnowledgeBase/Reports');
  });

  it('reads the prefixed and unprefixed spellings as the same path', () => {
    expect(normalizeWorkspacePath('KnowledgeBase/Reports', KB)).toBe(
      normalizeWorkspacePath('knowledge-base/KnowledgeBase/Reports', KB),
    );
  });

  it('drops the single leading slash of the root-anchored form', () => {
    expect(normalizeWorkspacePath('/knowledge-base/KnowledgeBase/Foo.md', KB)).toBe('knowledge-base/KnowledgeBase/Foo.md');
    expect(normalizeWorkspacePath('/knowledge-base', KB)).toBe('knowledge-base');
  });

  it('strips a leading "./" and collapses repeated slashes, as the platform always has', () => {
    expect(normalizeWorkspacePath('./KnowledgeBase/Foo.md', KB)).toBe('knowledge-base/KnowledgeBase/Foo.md');
    expect(normalizeWorkspacePath('./knowledge-base/Foo.md', KB)).toBe('knowledge-base/Foo.md');
    // One identity per file: the write turns and the lock rows coordinate on it.
    expect(normalizeWorkspacePath('knowledge-base//Foo.md', KB)).toBe('knowledge-base/Foo.md');
    expect(normalizeWorkspacePath('KnowledgeBase//Foo.md', KB)).toBe('knowledge-base/KnowledgeBase/Foo.md');
  });

  it('refuses traversal, backslashes and absolute paths with the existing message', () => {
    for (const p of [
      '../etc/hostname',
      'KnowledgeBase/../../stray.md',
      'knowledge-base/../stray.md',
      'knowledge-base/./x.md',
      'KnowledgeBase\\x',
      'knowledge-base\\KnowledgeBase\\x.md',
      '/tmp/x',
      '/etc/passwd',
      '//knowledge-base/Foo.md',
      // Drive-qualified, and drive-relative: absolute on Windows, where
      // `path.resolve` reads the drive and the workspace dir loses. Neither
      // carries a leading slash or a backslash, so both are named on their own.
      'C:/Windows/System32/drivers/etc/hosts',
      'c:/Windows',
      'C:Windows',
      '',
    ]) {
      expect(() => normalizeWorkspacePath(p, KB), p).toThrow(/outside the knowledge base repository/);
    }
  });

  it('never suggests a correction it would refuse itself', () => {
    for (const p of ['../etc/hostname', 'KnowledgeBase/../../stray.md', '/tmp/x', 'KnowledgeBase\\x']) {
      let corrected: string | undefined;
      try {
        normalizeWorkspacePath(p, KB);
      } catch (e) {
        corrected = /Use "([^"]*)" instead/.exec((e as Error).message)?.[1];
      }
      expect(corrected, p).toBeDefined();
      expect(normalizeWorkspacePath(corrected!, KB), p).toBe(corrected);
    }
  });

  it('refuses a non-string rather than crashing on it', () => {
    expect(() => normalizeWorkspacePath(undefined as unknown as string, KB)).toThrow(
      /outside the knowledge base repository/,
    );
  });

  it('uses the deployment\'s own clone folder name', () => {
    expect(normalizeWorkspacePath('KnowledgeBase/Foo.md', 'kb')).toBe('kb/KnowledgeBase/Foo.md');
    expect(normalizeWorkspacePath('kb/KnowledgeBase/Foo.md', 'kb')).toBe('kb/KnowledgeBase/Foo.md');
    // With a different name configured, the default name is ordinary content.
    expect(normalizeWorkspacePath('knowledge-base/Foo.md', 'kb')).toBe('kb/knowledge-base/Foo.md');
  });
});

describe('assertRepoRootNameFree', () => {
  it('reserves the checkout folder name at the repository root, and says why', () => {
    expect(() => assertRepoRootNameFree('knowledge-base/knowledge-base', KB)).toThrow(/is reserved/);
    expect(() => assertRepoRootNameFree('knowledge-base/knowledge-base', KB)).toThrow(
      /it is the checkout folder's name/,
    );
    expect(() => assertRepoRootNameFree('knowledge-base/knowledge-base/Notes.md', KB)).toThrow(/is reserved/);
    expect(() => assertRepoRootNameFree('knowledge-base/knowledge-base/', KB)).toThrow(/is reserved/);
  });

  it('reserves it in every case, because one filesystem in three folds them together', () => {
    // `Knowledge-Base/` and `knowledge-base/` are ONE folder on macOS and on
    // Windows, so a case variant creates exactly the unreachable folder this
    // refuses. Refused everywhere, so a repository stays clonable onto all three.
    expect(() => assertRepoRootNameFree('knowledge-base/Knowledge-Base/x.md', KB)).toThrow(
      /"Knowledge-Base" is reserved/,
    );
    expect(() => assertRepoRootNameFree('knowledge-base/KNOWLEDGE-BASE', KB)).toThrow(
      /refused in every spelling/,
    );
    // The exact-case refusal keeps its one sentence, with no aside about case.
    let message = '';
    try {
      assertRepoRootNameFree('knowledge-base/knowledge-base', KB);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('"knowledge-base" is reserved');
    expect(message).not.toContain('in every spelling');
  });

  it('leaves every other name alone, the namesakes deeper down included', () => {
    expect(() => assertRepoRootNameFree('knowledge-base/KnowledgeBase/knowledge-base', KB)).not.toThrow();
    expect(() => assertRepoRootNameFree('knowledge-base/knowledge-base-old', KB)).not.toThrow();
    expect(() => assertRepoRootNameFree('knowledge-base', KB)).not.toThrow();
    expect(() => assertRepoRootNameFree('knowledge-base/KnowledgeBase/Foo.md', KB)).not.toThrow();
  });
});

describe('normalizePathArgs', () => {
  it('normalizes every path-shaped tool argument, batch entries included', () => {
    expect(
      normalizePathArgs(
        {
          branch: '/main',
          path: '/knowledge-base/a.md',
          src: 'KnowledgeBase/b.md',
          dest: 'knowledge-base/c.md',
          destination: '/knowledge-base/d',
          files: [{ path: 'e.md', content: '/x' }],
        },
        KB,
      ),
    ).toEqual({
      branch: '/main',
      path: 'knowledge-base/a.md',
      src: 'knowledge-base/KnowledgeBase/b.md',
      dest: 'knowledge-base/c.md',
      destination: 'knowledge-base/d',
      files: [{ path: 'knowledge-base/e.md', content: '/x' }],
    });
  });

  it('leaves a spill ref alone — it belongs to no workspace', () => {
    expect(
      normalizePathArgs({ path: '__tool_chain_spill__/abc.json' }, KB, (v) => v.startsWith('__tool_chain_spill__/')),
    ).toEqual({ path: '__tool_chain_spill__/abc.json' });
  });

  it('leaves an absent or empty path to the handler\'s own required-argument message', () => {
    expect(normalizePathArgs({ path: undefined }, KB)).toEqual({ path: undefined });
    expect(normalizePathArgs({ path: '' }, KB)).toEqual({ path: '' });
    expect(normalizePathArgs({ branch: 'main' }, KB)).toEqual({ branch: 'main' });
  });

  it('collapses the spellings so two callers take one lock row', () => {
    expect(normalizePathArgs({ path: './knowledge-base//a.md' }, KB)).toEqual({ path: 'knowledge-base/a.md' });
  });

  it('refuses a traversing tool argument', () => {
    expect(() => normalizePathArgs({ path: '../escape.md' }, KB)).toThrow(/outside the knowledge base repository/);
  });
});

describe('assertRepoRootNameFreeArgs', () => {
  const reserved = `${KB}/${KB}/x.md`;

  it('refuses the reserved name on the inputs a tool creates at, batch entries included', () => {
    expect(() => assertRepoRootNameFreeArgs({ path: reserved }, KB, ['path'])).toThrow(/is reserved/);
    expect(() => assertRepoRootNameFreeArgs({ dest: `${KB}/${KB}` }, KB, ['dest'])).toThrow(/is reserved/);
    expect(() => assertRepoRootNameFreeArgs({ files: [{ path: `${KB}/ok.md` }, { path: reserved }] }, KB, ['files'])).toThrow(
      /is reserved/,
    );
  });

  it('looks only at the keys it is given, so a source or a delete of an existing one is left possible', () => {
    // A move OUT of the reserved folder: `src` is not a creation.
    expect(() => assertRepoRootNameFreeArgs({ src: reserved, dest: `${KB}/elsewhere/x.md` }, KB, ['dest'])).not.toThrow();
    expect(() => assertRepoRootNameFreeArgs({ path: reserved }, KB, [])).not.toThrow();
    expect(() => assertRepoRootNameFreeArgs({ path: undefined, files: 'not-a-list' }, KB, ['path', 'files'])).not.toThrow();
  });
});

describe('assertKbDirNameFree', () => {
  const layout = { knowledgeBaseDir: 'KnowledgeBase', skillsDir: 'Skills', pluginsDir: 'Plugins', agentsFile: 'AGENTS.md' };

  it('accepts a checkout folder name none of the repository roots use', () => {
    expect(() => assertKbDirNameFree('knowledge-base', layout)).not.toThrow();
  });

  it('refuses a checkout folder named like a repository root, in any case, naming both', () => {
    expect(() => assertKbDirNameFree('KnowledgeBase', layout)).toThrow(/knowledgeBaseDir \("KnowledgeBase"\)/);
    expect(() => assertKbDirNameFree('skills', layout)).toThrow(/skillsDir \("Skills"\)/);
    expect(() => assertKbDirNameFree('agents.md', layout)).toThrow(/agentsFile \("AGENTS.md"\)/);
  });
});
