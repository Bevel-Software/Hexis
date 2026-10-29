import { EMAIL_RE } from '../../lib/email';
import type { InvitationRequest, InvitationResult } from '@bevel-software/platform-shared';

/** Commas, semicolons and any whitespace separate; lower-cased, empty parts dropped. */
function tokens(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Split typed or pasted text into addresses. Commas, semicolons and any
 * whitespace separate; a `Name <address>` entry — what a mail client puts on
 * the clipboard when you copy a recipient list — contributes its address.
 * Lower-cased, because the server treats addresses that way and a chip for
 * `Juan@` beside one for `juan@` would be one person invited twice.
 *
 * A display name can hold the very separators the list uses: Outlook copies
 * `Doe, Jane <jane@example.com>`, others quote it (`"Doe, Jane" <…>`). So a
 * quoted name goes first, and the text before an angle-bracketed address is
 * read as its name — only the parts of it that are addresses themselves (a
 * bare one earlier in the list) survive. Text after the last bracketed entry
 * names nothing, so it splits as typed, a mistyped address included, and
 * shows as the invalid chip it is.
 */
export function splitEmails(text: string): string[] {
  const unquoted = text.replace(/"[^"]*"/g, ' ');
  const out: string[] = [];
  let rest = 0;
  for (const entry of unquoted.matchAll(/<([^<>]*)>/g)) {
    out.push(...tokens(unquoted.slice(rest, entry.index)).filter((part) => part.includes('@')));
    out.push(...tokens(entry[1] ?? ''));
    rest = entry.index + entry[0].length;
  }
  out.push(...tokens(unquoted.slice(rest)));
  return out;
}

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

export type InviteRole = 'member' | 'admin';

/** The Admin role's canonical name in `roles.yaml` (the backend's `ADMIN_CANONICAL`). */
const ADMIN_ROLE = 'admin';

/** What became of one address. */
export type InviteOutcome =
  /**
   * A new account. `startingPassword`: the password the platform generated
   * for it, held only for the result view to show once.
   * `notified`: how the deployment told the person of the invite (`'email'`
   * from the cloud's mail, say), as the server's listeners answered; absent
   * when nobody did and the inviter hands over the link themselves.
   */
  | {
      email: string;
      status: 'created';
      role: InviteRole;
      roleError?: string;
      startingPassword?: string;
      notified?: string[];
    }
  /**
   * Already had an account, which the invite left exactly as it was. Invited
   * as Admin by an admin, they are made one too: `promoted` when this call
   * did it, `alreadyAdmin` when they were one. `deactivated`: the promotion
   * was refused because the account is switched off.
   */
  | {
      email: string;
      status: 'existing';
      promoted?: boolean;
      alreadyAdmin?: boolean;
      roleError?: string;
      deactivated?: boolean;
    }
  /** The deployment's admission rules had no place for the account (a seat limit, say). */
  | { email: string; status: 'no-seat'; message: string }
  | { email: string; status: 'error'; message: string };

/** The address now has an account it can sign in to, new or already there. */
export function isInvited(outcome: InviteOutcome): boolean {
  return outcome.status === 'created' || (outcome.status === 'existing' && !outcome.deactivated);
}

/** The account was created with a generated starting password. */
export function gotPassword(outcome: InviteOutcome): boolean {
  return outcome.status === 'created' && Boolean(outcome.startingPassword);
}

/** The deployment emailed this person the invite itself, so the inviter need not send them the link. */
export function wasEmailed(outcome: InviteOutcome): boolean {
  return outcome.status === 'created' && (outcome.notified?.includes('email') ?? false);
}

/** The server refused a promotion because the account is switched off (`addMember`'s `ifActive`). */
function isSwitchedOff(err: unknown): boolean {
  return (err as { kind?: unknown } | null)?.kind === 'deactivated';
}

/**
 * Invite each address (`POST /api/invitations`). The server makes a NEW
 * account, with a generated starting password when `startingPassword` asks
 * for one (and always where password sign-in is the only way in), or says
 * the address already has one, which it leaves exactly as it was.
 *
 * One at a time, not in parallel. Each create asks the deployment's admission
 * rules for a place, and a host that sells seats answers from a count —
 * concurrent asks would race that count, and the order typed is the order
 * the seats should go in.
 *
 * Only a refusal the server marks as an admission refusal
 * (`kind: 'admission'`) is "no seat left". Any other is an error in the
 * server's own words.
 *
 * "Admin" is a role membership, not an account property, so for an admin
 * inviting as Admin it is a second write after the invitation, sent
 * `ifActive`: somebody who already had an account is made an Admin too,
 * unless it is switched off, and the row says so. The roster is read first
 * so an existing Admin (including one the server configuration fixes) is
 * reported as such rather than written again. A refused promotion leaves the
 * account standing as it was and says so on the row.
 */
export async function sendInvites(
  emails: string[],
  role: InviteRole,
  api: {
    sendInvitation(request: InvitationRequest): Promise<InvitationResult>;
    addMember(canonical: string, email: string, options?: { ifActive?: boolean }): Promise<unknown>;
    fetchRoles(): Promise<{ canonical: string; members: string[]; fixedMembers?: string[] }[]>;
  },
  options: { startingPassword?: boolean } = {},
): Promise<InviteOutcome[]> {
  /** Who is an Admin already; asked only when someone is to be made one. Unreadable means unknown. */
  let admins: Set<string> | null = null;
  if (role === 'admin') {
    try {
      const entry = (await api.fetchRoles()).find((r) => r.canonical === ADMIN_ROLE);
      admins = new Set([...(entry?.members ?? []), ...(entry?.fixedMembers ?? [])].map((e) => e.toLowerCase()));
    } catch {
      admins = null;
    }
  }
  const outcomes: InviteOutcome[] = [];
  for (const email of emails) {
    let result: InvitationResult;
    try {
      result = await api.sendInvitation({
        email,
        role,
        ...(options.startingPassword !== undefined ? { startingPassword: options.startingPassword } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create account';
      const kind = (err as { kind?: unknown } | null)?.kind;
      outcomes.push(
        kind === 'admission' ? { email, status: 'no-seat', message } : { email, status: 'error', message },
      );
      continue;
    }
    const created =
      result.status === 'created'
        ? {
            ...(result.startingPassword ? { startingPassword: result.startingPassword } : {}),
            ...(result.notified.length > 0 ? { notified: result.notified } : {}),
          }
        : null;
    if (role !== 'admin') {
      outcomes.push(created ? { email, status: 'created', role, ...created } : { email, status: 'existing' });
      continue;
    }
    if (!created && admins?.has(email.toLowerCase())) {
      outcomes.push({ email, status: 'existing', alreadyAdmin: true });
      continue;
    }
    try {
      await api.addMember(ADMIN_ROLE, email, { ifActive: true });
      outcomes.push(
        created ? { email, status: 'created', role: 'admin', ...created } : { email, status: 'existing', promoted: true },
      );
    } catch (err) {
      if (isSwitchedOff(err)) {
        // Only an account that was already there can be switched off.
        outcomes.push(created ? { email, status: 'created', role: 'member', ...created } : { email, status: 'existing', deactivated: true });
        continue;
      }
      const roleError = err instanceof Error ? err.message : 'Could not make them an admin';
      outcomes.push(
        created
          ? { email, status: 'created', role: 'member', roleError, ...created }
          : { email, status: 'existing', roleError },
      );
    }
  }
  return outcomes;
}
