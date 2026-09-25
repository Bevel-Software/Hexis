import { describe, it, expect } from 'vitest';
import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { ontologyOf } from './kb-layout.js';

/** `ontologyOf` under the default layout, which is what these cases are written against. */
const ont = (path: string, kbDirName?: string) => ontologyOf(path, DEFAULT_KB_LAYOUT, kbDirName);

describe('ontologyOf', () => {
  it('classifies under the knowledge-base root the layout names, not the default one', () => {
    const layout = { ...DEFAULT_KB_LAYOUT, knowledgeBaseDir: 'docs' };
    expect(ontologyOf('docs/Product/Knowledge/Foo.md', layout)).toBe('docs/Product');
    expect(ontologyOf('KnowledgeBase/Product/Knowledge/Foo.md', layout)).toBeNull();
  });

  it('resolves a named ontology under Knowledge', () => {
    expect(ont('KnowledgeBase/Product/Knowledge/Foo.md')).toBe('KnowledgeBase/Product');
  });

  it('resolves a named ontology under NodeTypes', () => {
    expect(ont('KnowledgeBase/Product/NodeTypes/Process.md')).toBe('KnowledgeBase/Product');
  });

  it('is space-safe in the ontology name', () => {
    expect(ont('KnowledgeBase/IT Architecture/NodeTypes/ServiceCommitment.md')).toBe(
      'KnowledgeBase/IT Architecture',
    );
  });

  it('treats a nested ontology directory as the full prefix before the marker', () => {
    expect(ont('KnowledgeBase/Plugin/Sub/Knowledge/x.md')).toBe('KnowledgeBase/Plugin/Sub');
  });

  it('returns null when the marker sits directly under KnowledgeBase/', () => {
    expect(ont('KnowledgeBase/Knowledge/Foo.md')).toBeNull();
    expect(ont('KnowledgeBase/NodeTypes/T.md')).toBeNull();
  });

  it('returns null for root-level Knowledge (not under KnowledgeBase/)', () => {
    expect(ont('Knowledge/Foo.md')).toBeNull();
  });

  it('returns null for Data/ ontologies (deliberate session-ontology exemption)', () => {
    // `Data/<X>` IS parsed into the graph (parser `ONTOLOGY_ROOTS`), but is
    // intentionally NOT classified here so the session-ontology gate treats
    // Data paths as neutral — pipeline agents read knowledge and write data
    // in one session (owner decision 2026-07-27). See the `ontologyOf`
    // docstring; this is not drift.
    expect(ont('Data/Ops/Knowledge/x.md')).toBeNull();
    expect(ont('Data/Ops/NodeTypes/Ticket.md')).toBeNull();
    // KnowledgeBase paths still classify as before.
    expect(ont('KnowledgeBase/Ops/Knowledge/x.md')).toBe('KnowledgeBase/Ops');
  });

  it('returns null for Plugins and root config (neutral)', () => {
    expect(ont('Plugins/some-skill/SKILL.md')).toBeNull();
    expect(ont('access.md')).toBeNull();
    expect(ont('roles.yaml')).toBeNull();
  });

  it('returns null for an ontology path with no marker segment', () => {
    expect(ont('KnowledgeBase/Product/Uploads/diagram.png')).toBeNull();
  });

  it('does not match substring lookalikes (segment equality)', () => {
    expect(ont('KnowledgeBase/Product/Knowledge-notes.md')).toBeNull();
    expect(ont('KnowledgeBase/Product/KnowledgeBase/x.md')).toBeNull();
  });

  it('strips a kbDirName prefix (normalized and un-normalized)', () => {
    expect(ont('knowledge-base/KnowledgeBase/Product/Knowledge/Foo.md', 'knowledge-base')).toBe(
      'KnowledgeBase/Product',
    );
    expect(ont('./knowledge-base/KnowledgeBase/GTM/NodeTypes/T.md', 'knowledge-base/')).toBe(
      'KnowledgeBase/GTM',
    );
  });

  it('normalizes backslashes and leading/trailing slashes', () => {
    expect(ont('/KnowledgeBase/Product/Knowledge/Foo.md/')).toBe('KnowledgeBase/Product');
    expect(ont('KnowledgeBase\\Product\\Knowledge\\Foo.md')).toBe('KnowledgeBase/Product');
  });

  it('canonicalizes inner . and .. segments to the same ontology', () => {
    expect(ont('KnowledgeBase/Product/./Knowledge/Foo.md')).toBe('KnowledgeBase/Product');
    expect(ont('KnowledgeBase/Product/Sub/../Knowledge/Foo.md')).toBe('KnowledgeBase/Product');
    expect(ont('KnowledgeBase/Platform/../Product/Knowledge/Foo.md')).toBe('KnowledgeBase/Product');
    // `..` also collapses inside the stripped kbDirName prefix.
    expect(ont('knowledge-base/x/../KnowledgeBase/GTM/NodeTypes/T.md', 'knowledge-base')).toBe(
      'KnowledgeBase/GTM',
    );
  });

  it('returns null for empty or root paths', () => {
    expect(ont('')).toBeNull();
    expect(ont('KnowledgeBase')).toBeNull();
    expect(ont('KnowledgeBase/Product')).toBeNull();
  });
});
