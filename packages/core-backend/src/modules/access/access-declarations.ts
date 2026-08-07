import type { FileTreeEntry, IWorkspaceService } from '@bevel-software/platform-shared';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';
import { accessMdPathForFolder } from './access-mutation.service.js';
import {
  EVERYONE_CANONICAL,
  KNOWN_VERBS,
  parseAccessFile,
  parseOwnAccessEntries,
  type ParsedEntry,
  type Verb,
} from './access-control.service.js';

/**
 * WHERE access rules are DECLARED inside a folder — a read-only inventory, not
 * a second resolver.
 *
 * A group's `access.md` is never the whole story: resolution is closeness-first,
 * so a rule written on a single skill or `.tool` inside the folder overrides the
 * folder's rule for the principals it names. An admin looking at a group's share
 * list and seeing "GTM Team can read" would otherwise have no way to know that
 * one battlecard underneath says `deny read: everyone`.
 *
 * So this module answers exactly one question — *which files declare access
 * rules under here, and what do they say* — and it answers it with the SAME
 * parsers the resolver builds its model from (`parseAccessFile` for `access.md`,
 * `parseOwnAccessEntries` for node frontmatter). Nothing here decides whether
 * anybody can do anything; it reports declarations verbatim. That is the whole
 * reason it can exist without touching `IAccessControl`, which enterprise
 * implements: a display of the stored rules cannot drift from the rules that
 * are enforced, because it is reading the same bytes through the same parse.
 */

/** A principal named by a declaration, in wire form. */
export type DeclarationPrincipal =
  | { kind: 'role'; role: string }
  | { kind: 'user'; email: string; name: string }
  | { kind: 'everyone' };

/** One `verb: principal` line of a declaration, deny-prefix preserved. */
export interface DeclarationEntry {
  verb: Verb;
  /** True when the line carried the literal `deny ` prefix. */
  deny: boolean;
  principal: DeclarationPrincipal;
}

export interface AccessDeclaration {
  /** Repo-relative path of the file that DECLARES the rules. */
  path: string;
  /**
   * Repo-relative path the rules GOVERN: the containing directory for an
   * `access.md`, the file itself for node frontmatter. Distinct from `path`
   * because that is what a reader needs to recognise ("the battlecards
   * folder"), and what the caller read-filters rows on.
   */
  governs: string;
  source: 'access-md' | 'frontmatter';
  entries: DeclarationEntry[];
  /**
   * Set (with `entries: []`) when an `access.md` failed to parse. Surfaced
   * rather than swallowed: a broken rule file is exactly the thing somebody
   * managing access has to be told about, and the resolver's forgiveness makes
   * it invisible everywhere else.
   */
  parseError?: string;
}

/**
 * How many files one scan will read. A group folder is small by construction;
 * this cap exists so a pathological folder (a whole ontology moved under
 * `Groups/`) degrades into an honest partial answer instead of pinning the
 * event loop. Callers surface `truncated` to the user.
 */
export const DECLARATION_SCAN_FILE_CAP = 400;

/** 400 for a target that is not a folder. */
export class AccessDeclarationsError extends WorkflowDomainError {
  constructor(message: string, status = 400) {
    super(message, status);
    this.name = 'AccessDeclarationsError';
  }
}

/** Node files whose own frontmatter may declare verbs. */
function isNodeCandidate(name: string): boolean {
  return name.endsWith('.md') || name.endsWith('.tool');
}

/** Walk a workspace-relative path down the file tree; null when absent. */
function findNode(root: FileTreeEntry, wsRelPath: string): FileTreeEntry | null {
  if (wsRelPath === '') return root;
  let node: FileTreeEntry = root;
  for (const segment of wsRelPath.split('/').filter(Boolean)) {
    const next = node.children?.find((c) => c.name === segment);
    if (!next) return null;
    node = next;
  }
  return node;
}

interface Candidate {
  /** Repo-relative path of the declaring file. */
  repoRel: string;
  /** Workspace-relative path, i.e. what `readFile` takes. */
  wsPath: string;
  isAccessMd: boolean;
}

function collectCandidates(node: FileTreeEntry, kbPrefix: string, out: Candidate[]): void {
  for (const child of node.children ?? []) {
    if (child.type === 'directory') {
      collectCandidates(child, kbPrefix, out);
      continue;
    }
    const isAccessMd = child.name === 'access.md';
    if (!isAccessMd && !isNodeCandidate(child.name)) continue;
    if (!child.relativePath.startsWith(kbPrefix)) continue;
    out.push({
      repoRel: child.relativePath.slice(kbPrefix.length),
      wsPath: child.relativePath,
      isAccessMd,
    });
  }
}

/** The directory a `<dir>/access.md` governs (`''` for the repo root's own). */
function dirOf(repoRelPath: string): string {
  const slash = repoRelPath.lastIndexOf('/');
  return slash === -1 ? '' : repoRelPath.slice(0, slash);
}

/**
 * `ParsedEntry` → wire principal. The canonical built-in `everyone` role
 * becomes its own kind rather than a role named "everyone": it is not a
 * roles.yaml role, it has no members to look up, and the UI says "Everyone"
 * about it — collapsing it here keeps that decision out of three renderers.
 */
function toPrincipal(entry: ParsedEntry): DeclarationPrincipal {
  if (entry.kind === 'user') {
    return { kind: 'user', email: entry.email, name: entry.displayName };
  }
  if (entry.role === EVERYONE_CANONICAL) return { kind: 'everyone' };
  return { kind: 'role', role: entry.displayRole };
}

/** Flatten a per-verb entry map into wire entries, verb order then file order. */
function toEntries(byVerb: Record<Verb, ParsedEntry[]>): DeclarationEntry[] {
  const out: DeclarationEntry[] = [];
  for (const verb of KNOWN_VERBS) {
    for (const entry of byVerb[verb] ?? []) {
      out.push({ verb, deny: entry.deny, principal: toPrincipal(entry) });
    }
  }
  return out;
}

/**
 * Every access declaration living INSIDE `folderRepoRel`.
 *
 * The folder's own `access.md` is deliberately excluded — that file is the
 * folder's summary, already shown as the main share list, and repeating it in a
 * list headed "item-specific rules" would read as a contradiction of itself.
 *
 * Failure modes are asymmetric on purpose, matching the resolver: a node whose
 * frontmatter is malformed is skipped silently (a typo in a skill's `owner:`
 * must not make the group's access page unreadable), while a malformed
 * `access.md` is REPORTED with its `parseError` (that file was written to
 * control access and currently controls nothing).
 *
 * Throws `AccessDeclarationsError` (400) when the target is a file. A target
 * that does not exist in the clone yields an empty result — an unmigrated or
 * not-yet-created folder is a normal state, not an error.
 */
export async function listAccessDeclarationsUnder(
  workspaceService: IWorkspaceService,
  workspaceId: string,
  kbDirName: string,
  folderRepoRel: string,
): Promise<{ overrides: AccessDeclaration[]; truncated: boolean }> {
  const tree = await workspaceService.listFiles(workspaceId);
  const kbPrefix = `${kbDirName}/`;
  const wsFolderPath = folderRepoRel ? `${kbPrefix}${folderRepoRel}` : kbDirName;

  const node = findNode(tree, wsFolderPath);
  if (!node) return { overrides: [], truncated: false };
  if (node.type !== 'directory') {
    throw new AccessDeclarationsError('path must be a folder');
  }

  const ownAccessMd = accessMdPathForFolder(folderRepoRel);
  const candidates: Candidate[] = [];
  collectCandidates(node, kbPrefix, candidates);

  const scannable = candidates
    .filter((c) => c.repoRel !== ownAccessMd)
    .sort((a, b) => (a.repoRel < b.repoRel ? -1 : a.repoRel > b.repoRel ? 1 : 0));
  const truncated = scannable.length > DECLARATION_SCAN_FILE_CAP;
  const scanned = truncated ? scannable.slice(0, DECLARATION_SCAN_FILE_CAP) : scannable;

  const rows = await Promise.all(
    scanned.map(async (candidate): Promise<AccessDeclaration | null> => {
      let text: string;
      try {
        text = await workspaceService.readFile(workspaceId, candidate.wsPath);
      } catch {
        // The tree said it was there and the disk disagrees (a concurrent
        // delete, a broken symlink). Nothing to declare — drop the row rather
        // than fail the whole scan for one file.
        return null;
      }

      if (candidate.isAccessMd) {
        const parsed = parseAccessFile(text, candidate.repoRel);
        if (!parsed.ok) {
          return {
            path: candidate.repoRel,
            governs: dirOf(candidate.repoRel),
            source: 'access-md',
            entries: [],
            parseError: parsed.errors.join('; '),
          };
        }
        // An `access.md` that parses to nothing (empty, or only unknown keys)
        // declares nothing: closeness-first resolution yields no verdict at that
        // scope, so the parent's rules apply unchanged. Listing it under
        // "item-specific rules" would announce an override that does not exist.
        const entries = toEntries(parsed.file.entries);
        if (entries.length === 0) return null;
        return {
          path: candidate.repoRel,
          governs: dirOf(candidate.repoRel),
          source: 'access-md',
          entries,
        };
      }

      const own = parseOwnAccessEntries(text);
      if (!own) return null;
      const entries = toEntries(own);
      if (entries.length === 0) return null;
      return {
        path: candidate.repoRel,
        governs: candidate.repoRel,
        source: 'frontmatter',
        entries,
      };
    }),
  );

  return { overrides: rows.filter((r): r is AccessDeclaration => r !== null), truncated };
}
