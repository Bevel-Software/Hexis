import type { FileContent } from '@mastra/core/workspace';
import { VersionControlDomainError } from '../../shared/domain-errors.js';
import { isAccessMdPath, parseOwnAccessEntries } from './access-grammar.js';
import { GROUPS_YAML, SYNCED_GROUPS_YAML } from './group-files.js';
import { ROLES_YAML_BASENAME } from './roles-yaml-guard.js';

/**
 * A bot never changes access (`modules/bots`): who may reach what is always
 * set by a person. This is the rule's ONE definition — which files decide
 * access, and when a write to any other file changes its own access lines —
 * asked by every place a bot's change can land: the lock every write
 * acquires, the agent's pre-disk write check, and the merge of a change
 * request.
 */

/**
 * Whether the repo-relative path is a file that decides access as a whole:
 * `roles.yaml`, any `access.md`, and the group files (a group's members are
 * who it grants to).
 */
export function isAccessFile(repoRelativePath: string): boolean {
  const p = repoRelativePath.replace(/^\/+/, '');
  return p === ROLES_YAML_BASENAME || p === GROUPS_YAML || p === SYNCED_GROUPS_YAML || isAccessMdPath(p);
}

/**
 * Whether replacing `before` (null: the file is new) with `after` changes the
 * access lines of the file's own definition — the `read:`, `write:`,
 * `download:` and `owner:` its frontmatter declares. A new file that declares
 * any changes them; reformatting that leaves the parsed lines equal does not.
 */
export function changesOwnAccessLines(before: string | null, after: string | null): boolean {
  const was = before === null ? null : parseOwnAccessEntries(before);
  const is = after === null ? null : parseOwnAccessEntries(after);
  return JSON.stringify(was) !== JSON.stringify(is);
}

/** A bot's write or merge that would change access, refused. 403: the bot is known; the change is not its to make. */
export class BotChangesAccessError extends VersionControlDomainError {
  constructor(path: string, what: 'file' | 'lines') {
    super(
      what === 'file'
        ? `A bot cannot change access: "${path}" decides who may reach what, and only a person may change it.`
        : `A bot cannot change access: this would change the access lines (read, write, download, owner) of "${path}". ` +
            'Leave them as they are; a person changes who may reach a file.',
      403,
      { kind: 'bot-cannot-change-access', path },
    );
    this.name = 'BotChangesAccessError';
  }
}

/**
 * The agent's pre-disk write check for a BOT: refuses a write to an access
 * file outright, and a write to any other file that changes its own access
 * lines, judged against what the file holds now (`readCurrent`, read under
 * the write's lock when the filesystem runs the check there). Paths are
 * workspace-relative; a path outside the knowledge base carries no rules.
 */
export function makeBotAccessWriteValidator(
  kbDirName: string,
  readCurrent: (wsPath: string) => Promise<string | null>,
): ((path: string, content: FileContent) => Promise<void>) & { appliesTo: (path: string) => boolean } {
  const prefix = `${kbDirName}/`;
  const repoRelative = (wsPath: string): string | null => {
    const p = wsPath.replace(/^\/+/, '');
    return p.startsWith(prefix) ? p.slice(prefix.length) : null;
  };
  const validate = async (wsPath: string, content: FileContent): Promise<void> => {
    const rel = repoRelative(wsPath);
    if (rel === null) return;
    if (isAccessFile(rel)) throw new BotChangesAccessError(rel, 'file');
    const after = typeof content === 'string' ? content : Buffer.isBuffer(content) ? content.toString('utf8') : null;
    if (after === null) return;
    if (changesOwnAccessLines(await readCurrent(wsPath), after)) throw new BotChangesAccessError(rel, 'lines');
  };
  // Every path inside the knowledge base: a copy or a move lands content at
  // a new path, and its access lines are new there.
  return Object.assign(validate, { appliesTo: (wsPath: string) => repoRelative(wsPath) !== null });
}
