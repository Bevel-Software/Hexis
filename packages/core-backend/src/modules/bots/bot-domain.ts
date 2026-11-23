import { isFrontmatterFence } from '@bevel-software/platform-shared';
import { canonicalEmail } from '../../shared/email-identity.js';
import { GROUPS_YAML, ROLES_YAML_BASENAME, SYNCED_GROUPS_YAML, isAccessMdPath } from '../access-model/index.js';

/**
 * The bots' domain, and how a change of it is carried through: every bot is
 * given its new address at once, one change request rewrites every grant
 * written at the old domain, and until that request is merged a grant at the
 * old domain still counts for its bot (`BotAddressBook`). A domain people's
 * addresses use, or text that is not a domain, is refused.
 */

/** A domain: dot-separated labels of lowercase letters, digits and inner hyphens, at least two of them. */
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why `domain` cannot be the bots' domain, given the people's addresses; null when it can. */
export function botsDomainRefusal(domain: string, peopleEmails: readonly string[], current: string): string | null {
  if (!DOMAIN.test(domain)) return `"${domain}" is not a domain. Enter the part after the @, such as bots.example.com.`;
  if (domain === current) return `The bots' domain is already ${domain}.`;
  const usedByPeople = peopleEmails.some((e) => canonicalEmail(e).endsWith(`@${domain}`));
  if (usedByPeople) return `People's addresses use ${domain}, so it cannot be the bots' domain.`;
  return null;
}

/** The domain an admin entered, as the setting stores it: trimmed, lower case, without a leading @. */
export function normalizeBotsDomain(input: unknown): string {
  return typeof input === 'string' ? input.trim().toLowerCase().replace(/^@+/, '') : '';
}

/**
 * Whether the repo-relative path is a file whose grants are written anywhere
 * in it: `roles.yaml`, any `access.md`, and the group files.
 */
export function isAccessFile(repoRelativePath: string): boolean {
  const p = repoRelativePath.replace(/^\/+/, '');
  return p === ROLES_YAML_BASENAME || p === GROUPS_YAML || p === SYNCED_GROUPS_YAML || isAccessMdPath(p);
}

/**
 * Rewrite every grant of a bot written at `from` to `to` in one file's text:
 * in an access file (an `access.md`, `roles.yaml`, a group file) anywhere,
 * and in any other file only within its frontmatter, where its own access
 * lines are. Null when nothing changes.
 */
export function rewriteBotGrants(
  path: string,
  text: string,
  botIds: readonly string[],
  from: string,
  to: string,
): string | null {
  if (botIds.length === 0) return null;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^A-Za-z0-9._%+-])(${botIds.map(escape).join('|')})@${escape(from)}(?![A-Za-z0-9.-])`, 'gi');
  const rewrite = (s: string) => s.replace(pattern, (_m, lead: string, id: string) => `${lead}${id}@${to}`);
  let next: string;
  if (isAccessFile(path)) {
    next = rewrite(text);
  } else {
    // The fences by the platform's one rule (`isFrontmatterFence`, which the
    // access model reads frontmatter with), so a grant the access model
    // enforces is a grant this rewrites. Lines keep their own endings: only
    // the lines between the fences change.
    const lines = text.split(/(?<=\n)/);
    const bare = (line: string) => line.replace(/\r?\n$/, '');
    if (lines.length === 0 || !isFrontmatterFence(bare(lines[0]))) return null;
    const close = lines.findIndex((line, i) => i > 0 && isFrontmatterFence(bare(line)));
    if (close === -1) return null;
    next = lines[0] + rewrite(lines.slice(1, close).join('')) + lines.slice(close).join('');
  }
  return next === text ? null : next;
}
