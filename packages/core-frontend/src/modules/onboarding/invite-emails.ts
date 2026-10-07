import { EMAIL_RE } from '../../lib/email';

/**
 * Split typed or pasted text into addresses. Commas, semicolons and any
 * whitespace separate; a `Name <address>` entry — what a mail client puts on
 * the clipboard when you copy a recipient list — contributes its address.
 * Lower-cased, because the server treats addresses that way and a chip for
 * `Juan@` beside one for `juan@` would be one person invited twice.
 */
export function splitEmails(text: string): string[] {
  return text
    .replace(/[^<>,;]*<([^<>]+)>/g, ' $1 ')
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
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
   */
  | { email: string; status: 'existing'; promoted?: boolean; alreadyAdmin?: boolean; roleError?: string }
  | { email: string; status: 'no-seat'; message: string }
  | { email: string; status: 'error'; message: string };

/** The address now has an account it can sign in to — new or not. */
export function isInvited(outcome: InviteOutcome): boolean {
  return outcome.status === 'created' || outcome.status === 'existing';
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
 * read just means every address is treated as new.
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
    listAccounts(): Promise<{ email: string }[]>;
    createAccount(email: string, name: string): Promise<void>;
    addMember(canonical: string, email: string): Promise<unknown>;
    fetchRoles(): Promise<{ canonical: string; members: string[]; fixedMembers?: string[] }[]>;
  },
): Promise<InviteOutcome[]> {
  let existing: Set<string> | null = null;
  try {
    existing = new Set((await api.listAccounts()).map((a) => a.email.toLowerCase()));
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
      if (role !== 'admin') {
        outcomes.push({ email, status: 'existing' });
      } else if (admins?.has(email.toLowerCase())) {
        outcomes.push({ email, status: 'existing', alreadyAdmin: true });
      } else {
        try {
          await api.addMember(ADMIN_ROLE, email);
          outcomes.push({ email, status: 'existing', promoted: true });
        } catch (err) {
          const roleError = err instanceof Error ? err.message : 'Could not make them an admin';
          outcomes.push({ email, status: 'existing', roleError });
        }
      }
      continue;
    }
    try {
      await api.createAccount(email, '');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create account';
      const status = (err as { status?: unknown } | null)?.status;
      outcomes.push(
        status === 403 ? { email, status: 'no-seat', message } : { email, status: 'error', message },
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
