import { describe, expect, it } from 'vitest';
import { isRootFolderSuggestion, rootFolderState } from '../root-folders';

describe('rootFolderState', () => {
  it('is found only on an exact match', () => {
    expect(rootFolderState('Skills', ['KnowledgeBase', 'Skills'])).toEqual({ kind: 'found' });
    expect(rootFolderState(' Skills ', ['Skills'])).toEqual({ kind: 'found' });
  });

  it('names a folder that differs only by case', () => {
    expect(rootFolderState('Skills', ['skills'])).toEqual({
      kind: 'variant',
      candidate: 'skills',
      difference: 'case',
    });
  });

  it('names a folder that differs by case and a trailing s, either way round', () => {
    expect(rootFolderState('Skills', ['skill'])).toEqual({
      kind: 'variant',
      candidate: 'skill',
      difference: 'case-and-trailing-s',
    });
    expect(rootFolderState('Plugin', ['plugins'])).toEqual({
      kind: 'variant',
      candidate: 'plugins',
      difference: 'case-and-trailing-s',
    });
  });

  it('names a folder that differs only by a trailing s, either way round', () => {
    expect(rootFolderState('Skills', ['Skill'])).toEqual({
      kind: 'variant',
      candidate: 'Skill',
      difference: 'trailing-s',
    });
    expect(rootFolderState('plugin', ['plugins'])).toEqual({
      kind: 'variant',
      candidate: 'plugins',
      difference: 'trailing-s',
    });
  });

  it('prefers the case-only match when both are there', () => {
    expect(rootFolderState('Skills', ['skill', 'SKILLS'])).toEqual({
      kind: 'variant',
      candidate: 'SKILLS',
      difference: 'case',
    });
  });

  it('is missing when nothing is like it', () => {
    expect(rootFolderState('Plugins', ['KnowledgeBase', 'Skills', 'Data'])).toEqual({ kind: 'missing' });
    expect(rootFolderState('Skills', [])).toEqual({ kind: 'missing' });
  });
});

describe('isRootFolderSuggestion', () => {
  it('offers names a root may take', () => {
    expect(['KnowledgeBase', 'skills', 'docs-2'].filter(isRootFolderSuggestion)).toEqual([
      'KnowledgeBase',
      'skills',
      'docs-2',
    ]);
  });

  it('holds back names the save would refuse: dot-folders and the reserved roots', () => {
    for (const name of ['.github', '.bevel', 'Data', 'agents', 'PIPELINES']) {
      expect(isRootFolderSuggestion(name)).toBe(false);
    }
  });
});
