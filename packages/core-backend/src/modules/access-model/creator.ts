/**
 * The pure half of the creator read-grant story: the creator identity, the
 * grant-plan contract the creation surfaces consume, and the splice-safe
 * principal for a creator. The service that DECIDES when a creation needs a
 * grant (filesystem stats, access checks) is `modules/access/creator-access.ts`;
 * this file carries only the types and pure helpers so downstream modules
 * (kb-fs, plugins, tool-helpers) never need an edge into the access module.
 */

import type { Principal } from './access-splice.js';

/**
 * How a pending creation gets its creator read grant.
 *   - `seed-access-md`: merge the grant into `wsRelPath` (a new directory's
 *     own `access.md`, workspace-relative) — BEFORE or alongside the creation,
 *     via the caller's own lock+commit machinery. The caller MUST re-read the
 *     file's CURRENT text under its lock and write `apply(current)` ('' when
 *     absent), never a precomputed fresh file: two concurrent creators can
 *     both plan a seed for the same new directory, and a blind overwrite
 *     would silently revoke whichever grant landed first. Skip the write when
 *     `apply` returns the input unchanged, and call `noteAccessFileWritten`
 *     after a write so the resolver cache drops.
 *   - `frontmatter`: run the new file's content through `apply` before
 *     writing it, so the grant lands atomically inside the created file.
 */
export type CreationGrantPlan =
  | { kind: 'seed-access-md'; wsRelPath: string; apply: (current: string) => string }
  | { kind: 'frontmatter'; apply: (content: string) => string };

/** The creator identity a grant is written for. */
export interface Creator {
  name: string;
  email: string;
}

/**
 * Injection seam for the creation surfaces (routes, lock-aware filesystem,
 * upload apply). Kept as an interface so callers depend on the contract, not
 * the class.
 */
export interface ICreatorAccess {
  planForCreate(
    workspaceId: string,
    creator: Creator,
    wsRelPath: string,
    kind: 'file' | 'dir',
  ): Promise<CreationGrantPlan | null>;

  grantInExtractedFile(
    workspaceId: string,
    creator: Creator,
    wsRelPath: string,
  ): Promise<string | null>;

  noteAccessFileWritten(workspaceId: string): void;
}

/**
 * The splice-safe principal for a creator — exported because plugin
 * provisioning (`PluginProvisionService`) writes the same `Name <email>`
 * entries into the access.md files it seeds, and two spellings of the same
 * person would read as two people.
 */
export function creatorPrincipal(creator: Creator): Principal {
  return { kind: 'user', email: creator.email, displayName: safeDisplayName(creator) };
}

/**
 * `Name <email>`-safe display name: `validatePrincipal` rejects control
 * chars, `<`, `>`, and `#`, so strip those from the user's name and fall
 * back to the email local part (which the email regex already keeps free of
 * `<>`/whitespace) when nothing usable remains.
 */
function safeDisplayName(creator: Creator): string {
  const strip = (s: string) =>
    // eslint-disable-next-line no-control-regex -- same intentional control-char guard as access-splice
    s.replace(/[<>#\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return strip(creator.name) || strip(creator.email.split('@')[0] ?? '') || 'KB user';
}
