import { EMAIL_RE } from '../../lib/email';

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
  | { email: string; status: 'created'; role: InviteRole; roleError?: string }
  /**
   * Already had an account. Invited as Admin, they are made one too:
   * `promoted` when this call did it, `alreadyAdmin` when they were one.
   * `deactivated`: the account is switched off and cannot sign in until an
   * admin switches it back on. Inviting does not do that — switching on asks
   * the deployment for a seat, and is the User accounts page's decision.
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

/** The address now has an account it can sign in to — new, or already there and switched on. */
export function isInvited(outcome: InviteOutcome): boolean {
  return outcome.status === 'created' || (outcome.status === 'existing' && !outcome.deactivated);
}

/**
 * Invite each address: an account with no password, waiting for that
 * person's first single sign-on (`POST /api/admin/accounts`).
 *
 * One at a time, not in parallel. Each create asks the deployment's admission
 * rules for a place, and a host that sells seats answers from a count —
 * concurrent asks would race that count, and the order the admin typed is the
 * order the seats should go in.
 *
 * The create endpoint is an upsert, so it cannot say "this person was already
 * here". The account list read first can, and an address already on it is
 * not created again: re-creating is not free (it asks for a seat again, and
 * a full plan refuses somebody who already HAS one). A list that cannot be
 * read just means every address is treated as new. The list holds
 * switched-off accounts too, and those are reported as such rather than as
 * able to sign in.
 *
 * Only a refusal the server marks as an admission refusal
 * (`kind: 'admission'`) is "no seat left". Any other is an error in the
 * server's own words — the route's admin check answers 403 as well, for an
 * admin verdict gone stale in another tab.
 *
 * "Admin" is a role membership, not an account property, so it is a second
 * write after the create. Somebody who already had an account is made an
 * Admin too when invited as one: the admin asked for that person to be an
 * Admin, and that they could already sign in does not change the request.
 * The roster is read first so an existing Admin (including one the server
 * configuration fixes) is reported as such rather than written again. A
 * refused promotion leaves the account standing as it was and says so on
 * the row.
 */
export async function sendInvites(
  emails: string[],
  role: InviteRole,
  api: {
    listAccounts(): Promise<{ email: string; deactivatedAt?: string | null }[]>;
    createAccount(email: string, name: string): Promise<void>;
    addMember(canonical: string, email: string): Promise<unknown>;
    fetchRoles(): Promise<{ canonical: string; members: string[]; fixedMembers?: string[] }[]>;
  },
): Promise<InviteOutcome[]> {
  /** Every address with an account, and whether that account is switched off. Unreadable means none known. */
  let existing: Map<string, boolean> | null = null;
  try {
    existing = new Map((await api.listAccounts()).map((a) => [a.email.toLowerCase(), Boolean(a.deactivatedAt)]));
  } catch {
    existing = null;
  }
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
    if (existing?.has(email.toLowerCase())) {
      const off = existing.get(email.toLowerCase()) ? { deactivated: true } : {};
      if (role !== 'admin') {
        outcomes.push({ email, status: 'existing', ...off });
      } else if (admins?.has(email.toLowerCase())) {
        outcomes.push({ email, status: 'existing', alreadyAdmin: true, ...off });
      } else {
        try {
          await api.addMember(ADMIN_ROLE, email);
          outcomes.push({ email, status: 'existing', promoted: true, ...off });
        } catch (err) {
          const roleError = err instanceof Error ? err.message : 'Could not make them an admin';
          outcomes.push({ email, status: 'existing', roleError, ...off });
        }
      }
      continue;
    }
    try {
      await api.createAccount(email, '');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create account';
      const kind = (err as { kind?: unknown } | null)?.kind;
      outcomes.push(
        kind === 'admission' ? { email, status: 'no-seat', message } : { email, status: 'error', message },
      );
      continue;
    }
    if (role !== 'admin') {
      outcomes.push({ email, status: 'created', role });
      continue;
    }
    try {
      await api.addMember(ADMIN_ROLE, email);
      outcomes.push({ email, status: 'created', role: 'admin' });
    } catch (err) {
      const roleError = err instanceof Error ? err.message : 'Could not make them an admin';
      outcomes.push({ email, status: 'created', role: 'member', roleError });
    }
  }
  return outcomes;
}
