import { describe, it, expect } from 'vitest';
import { currentBranchModel, isProtectedBranch } from '@bevel-software/platform-shared';
import {
  assertValidBranchName,
  assertValidRelativePath,
} from '../branch-name.js';
import { BranchNameError, WorkflowValidationError } from '../../../shared/domain-errors.js';

describe('assertValidBranchName', () => {
  it.each([
    'ali-raza/add-owner',
    'feature/x',
    'fix_123',
    'v1.2.3',
    'main',
    'release-2026.04',
  ])('accepts %s', (name) => {
    expect(() => assertValidBranchName(name)).not.toThrow();
  });

  it.each([
    ['empty', ''],
    ['leading dash', '-dangerous'],
    ['semicolon', 'foo;rm -rf /'],
    ['backtick', 'foo`whoami`'],
    ['space', 'foo bar'],
    ['double dot', 'foo..bar'],
    ['trailing slash', 'foo/'],
    ['trailing dot', 'foo.'],
    ['trailing .lock', 'foo.lock'],
    ['double slash', 'foo//bar'],
    ['ref expansion', 'HEAD@{0}'],
    ['null byte', 'foo\x00bar'],
    ['newline', 'foo\nbar'],
    ['path traversal', '../../etc/passwd'],
  ])('rejects %s (%s)', (_label, name) => {
    expect(() => assertValidBranchName(name)).toThrow(BranchNameError);
  });
});

describe('assertValidRelativePath', () => {
  it.each([
    'Knowledge/Foo.md',
    'NodeTypes/Process.md',
    'scripts/generate-mermaid.js',
    'a/b/c/d.md',
    'file-with-dash.md',
    // Pathspec glob characters used to be rejected here, but `GitService.git()`
    // now sets `GIT_LITERAL_PATHSPECS=1` on every git subprocess, so KB files
    // arriving with bracketed prefixes (`[Approved]`, `[New]`, `[Updated …]`)
    // or other glob metacharacters round-trip through commit cleanly.
    '[Approved] Handbook_Order archive.docx',
    'Handbook/[New] Handbook_E-Invoicing DE.docx',
    'Handbook/[Updated 03.09.2025] Handbook_How to search_Detail page.docx',
    'docs/wildcard*name.md',
    'docs/question?name.md',
    'docs/bang!name.md',
  ])('accepts %s', (p) => {
    expect(() => assertValidRelativePath(p)).not.toThrow();
  });

  it.each([
    ['empty', ''],
    ['absolute unix', '/etc/passwd'],
    ['windows drive', 'C:/Users/a'],
    ['parent segment', '../etc/passwd'],
    ['nested parent', 'a/../b'],
    ['current segment', 'a/./b'],
    ['null byte', 'a\x00b'],
    ['leading dash', '-afile'],
  ])('rejects %s (%s)', (_label, p) => {
    expect(() => assertValidRelativePath(p)).toThrow(WorkflowValidationError);
  });
});

describe('isProtectedBranch', () => {
  it('protects current-company-state and target-company-state', () => {
    expect(isProtectedBranch(currentBranchModel(), 'current-company-state')).toBe(true);
    expect(isProtectedBranch(currentBranchModel(), 'target-company-state')).toBe(true);
  });
  it('does not protect user branches', () => {
    expect(isProtectedBranch(currentBranchModel(), 'ali-raza/add-owner')).toBe(false);
    expect(isProtectedBranch(currentBranchModel(), 'main')).toBe(false);
    expect(isProtectedBranch(currentBranchModel(), 'develop')).toBe(false);
  });
});
