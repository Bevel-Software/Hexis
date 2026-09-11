import fs from 'node:fs/promises';
import path from 'node:path';
import { PLUGINS_DIR, isPersonalPluginFolder } from '@bevel-software/platform-shared';
import {
  EVERYONE_CANONICAL,
  KNOWN_VERBS,
  accessMdDeclaresBodyRules,
  parseAccessFile,
  parseOwnAccessEntries,
  sourceVerbsFor,
  type ParsedEntry,
  type Verb,
} from '../../../access-model/access-grammar.js';
import { spliceGrant } from '../../../access-model/access-splice.js';
import { isAbsence } from '../../../../shared/fs-errors.js';
import type { KbBranch, OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

/**
 * Keep every personal space closed to everyone but its owner — Admin
 * included — and let its access.md say so in both blocks.
 *
 * A personal folder's access.md used to be seeded with the owner's grants
 * alone. That is private only while nothing above it grants read — and the
 * usual way an administrator opens a knowledge base up is `read: everyone`
 * at the repository root, which then reached into every person's private
 * space. Personal folders seeded since deny `everyone` read outright; this
 * step gives the ones seeded before the same rule, on every branch, on the
 * next start. The file's own block gets the same statement (`deny
 * everyone` and the people the folder admits) where it used to say nothing
 * (`read: []`), so the file reads as what it is — see `isPrivateAccessMd`.
 *
 * A SPLICE, not a rewrite: the denial is added to the folder's read rules
 * (and, for the old seed's shape, the owner's grants are carried into
 * the folder's rules — see {@link closePersonalSpaceRules}); every other
 * byte — anyone the owner added, comments — stays. Idempotent: a folder
 * whose rules already deny `everyone` is left alone, so a person who removed
 * the denial on purpose would get it back once, on the upgrade that
 * introduces it, and not again.
 * Files that do not parse are the operator's to fix and are skipped.
 */
export class PersonalSpacesStep implements OnServerStart {
  readonly name = 'personal-spaces';

  async run(ctx: ServerStartContext): Promise<StepResult> {
    for (const branch of await ctx.allBranches()) {
      await closePersonalSpaces(branch);
    }
    return { outcome: 'ok' };
  }
}

async function closePersonalSpaces(branch: KbBranch): Promise<void> {
  const repoDir = await branch.repoDir();
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(repoDir, PLUGINS_DIR), { withFileTypes: true });
  } catch (err) {
    if (isAbsence(err)) return;
    throw err;
  }
  const closed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isPersonalPluginFolder(entry.name)) continue;
    const rel = `${PLUGINS_DIR}/${entry.name}/access.md`;
    let text: string;
    try {
      text = await fs.readFile(path.join(repoDir, rel), 'utf8');
    } catch (err) {
      if (isAbsence(err)) continue; // a folder with no rules is not a provisioned space
      throw err;
    }
    const next = closePersonalSpaceRules(text, rel);
    if (next === null) continue;
    branch.write(rel, next);
    closed.push(entry.name);
  }
  if (closed.length === 0) return;
  branch.note(`Keep ${closed.length === 1 ? 'a personal space' : `${closed.length} personal spaces`} private`);
  for (const name of closed) branch.note(`${PLUGINS_DIR}/${name}/access.md: read denies everyone`);
}

/**
 * The access.md text with `deny everyone` under the folder's `read:`, and
 * the same statement in the file's own block — or null when nothing needed
 * closing or the file cannot be parsed. Exported so a resolver test can
 * prove what the reconciled file means, not only what it says.
 *
 * The previous template put the owner's grants in the frontmatter over a
 * body of `read: []`. A body that declares a verb governs the folder, so
 * that file's folder rules were the empty body: the owner could see the
 * file and nothing beneath it. Closing such a file therefore also carries
 * every person the frontmatter grants into the folder block, so the owner
 * (and anyone they added) keeps what the frontmatter was meant to give
 * them.
 */
export function closePersonalSpaceRules(text: string, relativePath: string): string | null {
  const parsed = parseAccessFile(text, relativePath);
  if (!parsed.ok) return null;
  const folderClosed = closeFolderRules(text, parsed.file.entries);
  const next = closeFileRules(folderClosed, relativePath);
  return next === text ? null : next;
}

const everyone = (e: ParsedEntry) => e.kind === 'role' && e.role === EVERYONE_CANONICAL;

/** The body — the folder's rules — with `deny everyone` under `read:`; unchanged when already settled. */
function closeFolderRules(text: string, folder: Record<Verb, ParsedEntry[]>): string {
  // A file whose folder rules already settle `everyone`'s READ is left as it
  // is: an entry under `read` itself (a denial means the space is closed; a
  // grant means someone opened it on purpose), or a GRANT under a verb that
  // folds into read (`write`, `owner` — the grammar's own list). A denial
  // written beside such a grant would change nothing (a same-scope grant
  // wins) while making the file read as a contradiction. Anything else —
  // `deny everyone` under write alone, `download: everyone` — says nothing
  // about read, and the space is still open to an inherited `read: everyone`.
  const settled = sourceVerbsFor('read').some((verb) =>
    folder[verb].some((e) => everyone(e) && (verb === 'read' || !e.deny)),
  );
  if (settled) return text;
  let next = text;
  for (const { verb, entry } of strandedFrontmatterGrants(text, folder)) {
    next = spliceGrant(next, verb, { kind: 'user', email: entry.email, displayName: entry.displayName }, { target: 'folder' }).text;
  }
  return spliceGrant(next, 'read', { kind: 'role', role: 'everyone' }, { deny: true, target: 'folder' }).text;
}

/**
 * The frontmatter — the FILE's rules — saying what the folder's say: `deny
 * everyone`, then the people the folder admits (its user grants under
 * `read`, `write` and `owner`). Only for a file whose folder rules settle
 * `everyone`'s read as DENIED — a denial under `read` with no grant under
 * any verb that folds into read (`write: everyone` opens the folder to all
 * despite the denial, a same-scope grant winning): a space its owner opened
 * on purpose, either way, keeps the file open too. A frontmatter that
 * already mentions `everyone` under `read` — a denial, or a grant that
 * lists the file for all — is left as written; so is a legacy single-block
 * file, whose frontmatter IS the folder's rules and was closed above.
 */
function closeFileRules(text: string, relativePath: string): string {
  if (!accessMdDeclaresBodyRules(text)) return text;
  const own = parseOwnAccessEntries(text);
  if (own?.read.some(everyone)) return text;
  const parsed = parseAccessFile(text, relativePath);
  if (!parsed.ok) return text;
  const folder = parsed.file.entries;
  const folderReadIsDenied =
    folder.read.some((e) => everyone(e) && e.deny) &&
    !sourceVerbsFor('read').some((verb) => folder[verb].some((e) => everyone(e) && !e.deny));
  if (!folderReadIsDenied) return text;
  let next = spliceGrant(text, 'read', { kind: 'role', role: 'everyone' }, { deny: true, target: 'node', allowScalar: false }).text;
  const named = new Set<string>();
  for (const verb of sourceVerbsFor('read')) {
    for (const entry of folder[verb]) {
      if (entry.kind !== 'user' || entry.deny || named.has(entry.email)) continue;
      named.add(entry.email);
      next = spliceGrant(
        next,
        'read',
        { kind: 'user', email: entry.email, displayName: entry.displayName },
        { target: 'node', allowScalar: false },
      ).text;
    }
  }
  return next;
}

/**
 * People the frontmatter grants that the folder rules do not — non-empty only
 * for a body-governed file whose frontmatter still carries the old seed's
 * owner grants. A legacy file (no body rules) has nothing stranded: its
 * frontmatter IS the folder's rules.
 */
function strandedFrontmatterGrants(
  text: string,
  folder: Record<Verb, ParsedEntry[]>,
): { verb: Verb; entry: Extract<ParsedEntry, { kind: 'user' }> }[] {
  if (!accessMdDeclaresBodyRules(text)) return [];
  const own = parseOwnAccessEntries(text);
  if (!own) return [];
  const out: { verb: Verb; entry: Extract<ParsedEntry, { kind: 'user' }> }[] = [];
  for (const verb of KNOWN_VERBS) {
    for (const entry of own[verb]) {
      if (entry.kind !== 'user' || entry.deny) continue;
      // Any entry for that person under that verb — a grant OR a denial — is
      // the folder's own word on them; a denial someone wrote there on
      // purpose must not be overridden by the frontmatter's older grant.
      const held = folder[verb].some((e) => e.kind === 'user' && e.email === entry.email);
      if (!held) out.push({ verb, entry });
    }
  }
  return out;
}
