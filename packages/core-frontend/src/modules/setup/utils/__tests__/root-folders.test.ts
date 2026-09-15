import { describe, expect, it } from 'vitest';
import { rootFolderState } from '../root-folders';

describe('rootFolderState', () => {
  it('is found only on an exact match', () => {
    expect(rootFolderState('Skills', ['KnowledgeBase', 'Skills'])).toEqual({ kind: 'found' });
    expect(rootFolderState(' Skills ', ['Skills'])).toEqual({ kind: 'found' });
  });

  it('names a folder that differs only by case', () => {
    expect(rootFolderState('Skills', ['skills'])).toEqual({
      kind: 'variant',
      candidate: 'skills',
      caseOnly: true,
    });
  });

  it('names a folder that differs by case and a trailing s, either way round', () => {
    expect(rootFolderState('Skills', ['skill'])).toEqual({
      kind: 'variant',
      candidate: 'skill',
      caseOnly: false,
    });
    expect(rootFolderState('Plugin', ['plugins'])).toMatchObject({ kind: 'variant', candidate: 'plugins' });
  });

  it('prefers the case-only match when both are there', () => {
    expect(rootFolderState('Skills', ['skill', 'SKILLS'])).toMatchObject({ candidate: 'SKILLS', caseOnly: true });
  });

  it('is missing when nothing is like it', () => {
    expect(rootFolderState('Plugins', ['KnowledgeBase', 'Skills', 'Data'])).toEqual({ kind: 'missing' });
    expect(rootFolderState('Skills', [])).toEqual({ kind: 'missing' });
  });
});
