import { describe, it, expect } from 'vitest';
import { ontologyOf } from './kb-layout.js';

describe('ontologyOf', () => {
  it('resolves a named ontology under Knowledge', () => {
    expect(ontologyOf('KnowledgeBase/Product/Knowledge/Foo.md')).toBe('KnowledgeBase/Product');
  });

  it('resolves a named ontology under NodeTypes', () => {
    expect(ontologyOf('KnowledgeBase/Product/NodeTypes/Process.md')).toBe('KnowledgeBase/Product');
  });

  it('is space-safe in the ontology name', () => {
    expect(ontologyOf('KnowledgeBase/IT Architecture/NodeTypes/ServiceCommitment.md')).toBe(
      'KnowledgeBase/IT Architecture',
    );
  });

  it('treats a nested ontology directory as the full prefix before the marker', () => {
    expect(ontologyOf('KnowledgeBase/Group/Sub/Knowledge/x.md')).toBe('KnowledgeBase/Group/Sub');
  });

  it('returns null when the marker sits directly under KnowledgeBase/', () => {
    expect(ontologyOf('KnowledgeBase/Knowledge/Foo.md')).toBeNull();
    expect(ontologyOf('KnowledgeBase/NodeTypes/T.md')).toBeNull();
  });

  it('returns null for root-level Knowledge (not under KnowledgeBase/)', () => {
    expect(ontologyOf('Knowledge/Foo.md')).toBeNull();
  });

  it('returns null for Data/ ontologies (deliberate session-ontology exemption)', () => {
    // `Data/<X>` IS parsed into the graph (parser `ONTOLOGY_ROOTS`), but is
    // intentionally NOT classified here so the session-ontology gate treats
    // Data paths as neutral — pipeline agents read knowledge and write data
    // in one session (owner decision 2026-07-27). See the `ontologyOf`
    // docstring; this is not drift.
    expect(ontologyOf('Data/Ops/Knowledge/x.md')).toBeNull();
    expect(ontologyOf('Data/Ops/NodeTypes/Ticket.md')).toBeNull();
    // KnowledgeBase paths still classify as before.
    expect(ontologyOf('KnowledgeBase/Ops/Knowledge/x.md')).toBe('KnowledgeBase/Ops');
  });

  it('returns null for Groups and root config (neutral)', () => {
    expect(ontologyOf('Groups/some-skill/SKILL.md')).toBeNull();
    expect(ontologyOf('access.md')).toBeNull();
    expect(ontologyOf('roles.yaml')).toBeNull();
  });

  it('returns null for an ontology path with no marker segment', () => {
    expect(ontologyOf('KnowledgeBase/Product/Uploads/diagram.png')).toBeNull();
  });

  it('does not match substring lookalikes (segment equality)', () => {
    expect(ontologyOf('KnowledgeBase/Product/Knowledge-notes.md')).toBeNull();
    expect(ontologyOf('KnowledgeBase/Product/KnowledgeBase/x.md')).toBeNull();
  });

  it('strips a kbDirName prefix (normalized and un-normalized)', () => {
    expect(ontologyOf('knowledge-base/KnowledgeBase/Product/Knowledge/Foo.md', 'knowledge-base')).toBe(
      'KnowledgeBase/Product',
    );
    expect(ontologyOf('./knowledge-base/KnowledgeBase/GTM/NodeTypes/T.md', 'knowledge-base/')).toBe(
      'KnowledgeBase/GTM',
    );
  });

  it('normalizes backslashes and leading/trailing slashes', () => {
    expect(ontologyOf('/KnowledgeBase/Product/Knowledge/Foo.md/')).toBe('KnowledgeBase/Product');
    expect(ontologyOf('KnowledgeBase\\Product\\Knowledge\\Foo.md')).toBe('KnowledgeBase/Product');
  });

  it('canonicalizes inner . and .. segments to the same ontology', () => {
    expect(ontologyOf('KnowledgeBase/Product/./Knowledge/Foo.md')).toBe('KnowledgeBase/Product');
    expect(ontologyOf('KnowledgeBase/Product/Sub/../Knowledge/Foo.md')).toBe('KnowledgeBase/Product');
    expect(ontologyOf('KnowledgeBase/Platform/../Product/Knowledge/Foo.md')).toBe('KnowledgeBase/Product');
    // `..` also collapses inside the stripped kbDirName prefix.
    expect(ontologyOf('knowledge-base/x/../KnowledgeBase/GTM/NodeTypes/T.md', 'knowledge-base')).toBe(
      'KnowledgeBase/GTM',
    );
  });

  it('returns null for empty or root paths', () => {
    expect(ontologyOf('')).toBeNull();
    expect(ontologyOf('KnowledgeBase')).toBeNull();
    expect(ontologyOf('KnowledgeBase/Product')).toBeNull();
  });
});
