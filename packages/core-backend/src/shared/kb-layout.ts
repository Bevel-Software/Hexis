import { KNOWLEDGE_BASE_DIR, ONTOLOGY_MARKERS, type Ontology } from '@bevel-software/shared';

/**
 * Resolve which named ontology a KB path belongs to — the backend-side
 * implementation of the layout contract whose constants/types live in
 * `@bevel-software/shared` (`kb-layout.ts`). It is backend-only and consumed by
 * more than one domain module (the `workspace` read gate and the `workflow`
 * session-ontology service), so it lives in `backend/src/shared` rather than in
 * any single module — importable by both modules without crossing a module's
 * internal boundary. Note it does NOT mirror the kb-graph parser one-to-one:
 * see the `ontologyOf` docstring for the deliberate `Data/` exemption.
 *
 * Pure string handling — no IO, no DB.
 */

/**
 * Split a path into repo-root-relative POSIX segments, dropping `./`,
 * leading/trailing slashes, and an optional `kbDirName` prefix (the on-disk
 * clone folder, e.g. `knowledge-base/`). Pure string handling — no IO.
 */
function toSegments(path: string, kbDirName?: string): string[] {
  // Collapse to canonical segments: backslashes → `/`, drop empty and `.`
  // segments, resolve `..` against the accumulated prefix. Canonicalizing the
  // inner segments (not just the ends) means equivalent paths like
  // `KnowledgeBase/Product/../Product/Knowledge/x.md` and
  // `KnowledgeBase/Product/Knowledge/x.md` resolve to the same ontology.
  const collapse = (s: string): string[] => {
    const out: string[] = [];
    for (const seg of s.replace(/\\/g, '/').split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        // Pop a real segment; a leading `..` (nothing to pop) is kept so it can
        // never alias into a sibling ontology.
        if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
        else out.push('..');
        continue;
      }
      out.push(seg);
    }
    return out;
  };

  let segs = collapse(path);
  const prefixSegs = kbDirName ? collapse(kbDirName) : [];
  if (prefixSegs.length > 0 && prefixSegs.every((s, i) => segs[i] === s)) {
    segs = segs.slice(prefixSegs.length);
  }
  return segs;
}

/**
 * Resolve the named ontology a KB path belongs to, or `null` (neutral) when it
 * belongs to none.
 *
 * Classification is deliberately NARROWER than the kb-graph parser: the parser
 * discovers ontologies under every `ONTOLOGY_ROOTS` entry (`KnowledgeBase/`
 * AND `Data/`), but this function classifies ONLY `KnowledgeBase/` paths.
 * `Data/` ontologies are parsed into the graph yet are intentionally NOT
 * classified here, so the session-ontology gate treats `Data/` paths as
 * neutral — pipeline agents read knowledge and write data records in one
 * session (owner decision 2026-07-27; the cross-ontology boundary mechanism
 * itself may be redesigned). This divergence is on purpose, not drift.
 *
 * Within `KnowledgeBase/`, the shape matches the parser (`parser.ts`
 * `walkForOntologies`): an ontology is the directory that holds both a
 * `Knowledge/` and a `NodeTypes/` subfolder. That directory can sit at ANY
 * depth under `KnowledgeBase/`, so the ontology id is the path PREFIX up to
 * (but excluding) the first `Knowledge/` or `NodeTypes/` marker segment — as
 * long as that prefix is inside `KnowledgeBase/` and is not `KnowledgeBase/`
 * itself.
 *
 *   KnowledgeBase/Product/Knowledge/Foo.md            → "KnowledgeBase/Product"
 *   KnowledgeBase/IT Architecture/NodeTypes/T.md      → "KnowledgeBase/IT Architecture"
 *   KnowledgeBase/Group/Sub/Knowledge/x.md            → "KnowledgeBase/Group/Sub"
 *   KnowledgeBase/Knowledge/Foo.md                    → null (marker directly under KB root)
 *   Knowledge/Foo.md, Skills/x.md, access.md          → null (not under KnowledgeBase/)
 *   Data/Ops/Knowledge/x.md                           → null (Data/ is exempt — see above)
 *   KnowledgeBase/Product/Uploads/x.png               → null (no marker segment)
 *
 * Uses exact segment equality (never substring), so `KnowledgeBase/` and
 * `Knowledge-notes.md` are never treated as markers; space-safe; pure (no IO).
 *
 * @param path       repo-root-relative POSIX path (may carry a `kbDirName` prefix)
 * @param kbDirName  optional on-disk clone folder prefix to strip first
 */
export function ontologyOf(path: string, kbDirName?: string): Ontology {
  const segs = toSegments(path, kbDirName);
  // Must live under the dedicated KnowledgeBase/ container, with at least one
  // ontology-name segment and a marker after it (so length >= 3).
  if (segs.length < 3 || segs[0] !== KNOWLEDGE_BASE_DIR) return null;
  // The ontology id is the prefix before the first marker segment. Require at
  // least one name segment between `KnowledgeBase/` and the marker, so a marker
  // sitting directly under `KnowledgeBase/` (`KnowledgeBase/Knowledge/...`) is
  // neutral, matching the parser (it only discovers ontologies one level down).
  for (let i = 1; i < segs.length; i++) {
    if (ONTOLOGY_MARKERS.has(segs[i])) {
      return i >= 2 ? segs.slice(0, i).join('/') : null;
    }
  }
  return null;
}
