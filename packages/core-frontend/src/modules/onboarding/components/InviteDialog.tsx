import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, KeyRound, RotateCw } from 'lucide-react';
import { Badge, Banner, Button, Dialog, type BadgeTone } from '../../../shared/components';
import { SlotBoundary } from '../../../shared/components/SlotBoundary';
import { useAppRegistry } from '../../../core/registry';
import { useAuth, useSignInMethods, sendInvitation } from '../../auth';
import type { LoginProviders } from '../../auth';
import { AdminContext, addMember, fetchRoles } from '../../admin';
import { copyToClipboard } from '../../library';
import { initials } from '../../../lib/email';
import { EmailChipsInput } from './EmailChipsInput';
import {
  gotPassword,
  isInvited,
  isValidEmail,
  sendInvites,
  wasEmailed,
  splitEmails,
  type InviteOutcome,
  type InviteRole,
} from '../invite-emails';

/** "1 person" / "3 people" — the one plural this dialog needs. */
function people(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/** "A", "A or B", "A, B or C": the single sign-on providers, by their labels. */
function either(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/**
 * What the form offers, from how the deployment signs people in:
 * - `password`: password sign-in and no single sign-on — every new account
 *   gets a generated starting password, or nobody invited could sign in (the
 *   owner's and the system accounts' addresses excepted: the answer says);
 * - `sso`: single sign-on and password sign-in — a generated password is an
 *   option;
 * - `sso-only`: password sign-in is off — no password at all;
 * - `none`: password sign-in is off and no single sign-on is on either —
 *   nobody invited could sign in, so nothing can be sent;
 * - `unknown`: not known yet, or the check failed — nothing can be sent.
 */
type FormMode = 'password' | 'sso' | 'sso-only' | 'none' | 'unknown';

function formMode(methods: LoginProviders | null): FormMode {
  if (!methods) return 'unknown';
  if (!methods.password) return methods.sso.length > 0 ? 'sso-only' : 'none';
  return methods.sso.length > 0 ? 'sso' : 'password';
}

interface InviteDialogProps {
  open: boolean;
  onClose(): void;
  /** Called after a send that created or changed at least one account. */
  onInvited?(): void;
  /** Addresses already in the field when it opens (Manage access's Invite). */
  initialEmails?: string[];
}

/**
 * Invite your team: addresses in, accounts out, under the same access rules
 * as everything else (Share → Manage access decides what they then see).
 *
 * Anyone signed in invites; only an admin chooses the Role (Member or
 * Admin), and everyone else invites Members, which is all the server takes
 * from them.
 *
 * How the invited people get in depends on the deployment, so the dialog
 * asks it first (`GET /api/auth/providers`) and lets nothing be sent until it
 * knows. Nobody types a password: without single sign-on the server
 * generates one for every new account but an owner's or a system account's;
 * with single sign-on that is an
 * option. An account that is already there is left exactly as it was.
 *
 * Two views in one dialog. The form; then, after sending, who is invited,
 * how each of them signs in, and how to tell them. The second view exists
 * because creating an account sends nobody anything — core has no mail — so
 * the inviter leaves with the sign-in address and a message to forward, not
 * with an assumption that people were notified.
 *
 * A generated password is shown on its row in the result view, with a Copy
 * button, and nowhere else: never in the message, never again after Done or
 * "Invite more people" (both drop the outcomes), and gone with the dialog.
 *
 * Feedback stays INSIDE the dialog: the Library's toasts only exist under its
 * own routes, and this opens from Knowledge too.
 */
export function InviteDialog({ open, onClose, onInvited, initialEmails }: InviteDialogProps) {
  const { user } = useAuth();
  // Optional context: the dialog is mounted bare in tests, and a verdict not
  // in yet reads as "not an admin" — a Member invite, which is always allowed.
  const isAdmin = useContext(AdminContext)?.isAdmin ?? false;
  const signIn = useSignInMethods();
  const methods = signIn.status === 'ready' ? signIn.methods : null;
  const mode = formMode(methods);
  const [emails, setEmails] = useState<string[]>(() => initialEmails ?? []);
  const [draft, setDraft] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [alsoPassword, setAlsoPassword] = useState(false);
  const [sending, setSending] = useState(false);
  // The outcomes of the last send; the generated passwords live here and nowhere else.
  const [outcomes, setOutcomes] = useState<InviteOutcome[] | null>(null);
  const emailsId = useId();
  const doneRef = useRef<HTMLButtonElement>(null);

  // The address field, not the header's close button, is where an invite
  // starts: on open and again after "Invite more people". A frame late on
  // purpose — the dialog moves focus to its first control as it opens, and
  // that runs after this component's own effects.
  useEffect(() => {
    if (!open || outcomes) return;
    const frame = requestAnimationFrame(() => document.getElementById(emailsId)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, outcomes, emailsId]);

  // The button that sent is gone once the result shows; focus goes to the
  // way out rather than falling to the page behind the dialog.
  useEffect(() => {
    if (outcomes) doneRef.current?.focus();
  }, [outcomes]);

  // What a send would include: the chips plus anything still in the field,
  // so typing one address and clicking Invite does what it says.
  const pending = [...emails];
  for (const email of splitEmails(draft)) if (!pending.includes(email)) pending.push(email);
  const valid = pending.filter(isValidEmail);
  const wantsPassword = mode === 'password' || (mode === 'sso' && alsoPassword);
  const canSend = mode !== 'unknown' && mode !== 'none' && valid.length > 0 && !sending;

  async function send() {
    if (!canSend) return;
    setSending(true);
    try {
      const result = await sendInvites(
        valid,
        isAdmin ? role : 'member',
        { sendInvitation, addMember, fetchRoles },
        { startingPassword: wantsPassword },
      );
      setEmails([]);
      setDraft('');
      setOutcomes(result);
      if (result.some((o) => o.status === 'created' || (o.status === 'existing' && o.promoted))) {
        onInvited?.();
      }
    } finally {
      setSending(false);
    }
  }

  function inviteMore() {
    setEmails([]);
    setDraft('');
    setRole('member');
    setAlsoPassword(false);
    setOutcomes(null);
  }

  if (outcomes) {
    const invited = outcomes.filter(isInvited).length;
    return (
      <Dialog
        open={open}
        onClose={onClose}
        size="lg"
        title={
          invited === 0
            ? 'Nobody was invited'
            : `${people(invited)} ${invited === 1 ? 'is' : 'are'} invited`
        }
        footer={
          <>
            <Button variant="quiet" size="sm" className="mr-auto" onClick={inviteMore}>
              Invite more people
            </Button>
            <Button ref={doneRef} variant="primary" size="sm" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <InvitedBody outcomes={outcomes} invited={invited} methods={methods} isAdmin={isAdmin} />
      </Dialog>
    );
  }

  const domain = user?.email.split('@')[1];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={sending}
      size="lg"
      title="Invite your team"
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void send()} disabled={!canSend}>
            {sending
              ? 'Inviting…'
              : valid.length > 0
                ? `Invite ${people(valid.length)}`
                : 'Invite people'}
          </Button>
        </>
      }
    >
      <InviteFormBody
        mode={mode}
        alert={
          signIn.status === 'failed' ? (
            <RetryAlert text="Couldn’t check how people sign in here." onRetry={signIn.retry} />
          ) : mode === 'none' ? (
            <Banner tone="danger" role="alert">
              Nobody could sign in: password sign-in is off here and no single sign-on is set up.
            </Banner>
          ) : null
        }
        ssoLabels={methods?.sso.map((p) => p.label) ?? []}
        emailsId={emailsId}
        emails={emails}
        onEmailsChange={setEmails}
        draft={draft}
        onDraftChange={setDraft}
        showRole={isAdmin}
        role={role}
        onRoleChange={setRole}
        alsoPassword={alsoPassword}
        onAlsoPasswordChange={setAlsoPassword}
        validCount={valid.length}
        invalidCount={pending.length - valid.length}
        sending={sending}
        placeholder={domain ? `name@${domain}` : 'name@company.com'}
      />
    </Dialog>
  );
}

/** A red bar saying what went wrong, with a Retry beside it. */
function RetryAlert({ text, onRetry }: { text: string; onRetry(): void }) {
  return (
    <Banner tone="danger" role="alert">
      <div className="flex items-center gap-3">
        <span className="flex-1">{text}</span>
        <Button size="sm" leadingIcon={<RotateCw size={14} aria-hidden />} onClick={onRetry}>
          Retry
        </Button>
      </div>
    </Banner>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-detail font-medium text-ink">
      {children}
    </label>
  );
}

function InviteFormBody({
  mode,
  alert,
  ssoLabels,
  emailsId,
  emails,
  onEmailsChange,
  draft,
  onDraftChange,
  showRole,
  role,
  onRoleChange,
  alsoPassword,
  onAlsoPasswordChange,
  validCount,
  invalidCount,
  sending,
  placeholder,
}: {
  mode: FormMode;
  alert: ReactNode;
  ssoLabels: string[];
  emailsId: string;
  emails: string[];
  onEmailsChange(next: string[]): void;
  draft: string;
  onDraftChange(next: string): void;
  /** The Role choice is an admin's: anyone else invites Members. */
  showRole: boolean;
  role: InviteRole;
  onRoleChange(next: InviteRole): void;
  alsoPassword: boolean;
  onAlsoPasswordChange(next: boolean): void;
  validCount: number;
  /**
   * Addresses a send would leave out — chips and text still in the field
   * alike, since a send clears both and the field's would otherwise go
   * without a word.
   */
  invalidCount: number;
  sending: boolean;
  placeholder: string;
}) {
  const Extras = useAppRegistry().inviteExtras;
  const invalidId = useId();
  const roleId = useId();

  const withPassword = mode === 'password' || (mode === 'sso' && alsoPassword);
  const idp = either(ssoLabels);
  const help =
    mode === 'password'
      ? 'They sign in with their email and a password made for them. You see it once, after you invite, to pass on.'
      : (mode === 'sso' || mode === 'sso-only') && idp
        ? withPassword
          ? `They sign in with ${idp}, or with their email and a password made for them. You see it once, after you invite.`
          : `They sign in with ${idp}.`
        : null;

  return (
    <div className="flex flex-col gap-5 py-2">
      {alert}
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor={emailsId}>Emails</FieldLabel>
        <EmailChipsInput
          id={emailsId}
          emails={emails}
          onEmailsChange={onEmailsChange}
          draft={draft}
          onDraftChange={onDraftChange}
          placeholder={placeholder}
          aria-describedby={invalidCount > 0 ? invalidId : undefined}
          disabled={sending}
        />
        {invalidCount > 0 && (
          <span id={invalidId} className="text-meta text-danger">
            {invalidCount === 1 ? 'One address isn’t' : `${invalidCount} addresses aren’t`} valid and won’t be
            invited.
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <div className={`grid gap-3 items-end ${showRole ? 'grid-cols-[9rem_1fr]' : 'grid-cols-1'}`}>
          {showRole && (
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={roleId}>Role</FieldLabel>
              <div className="relative">
                <select
                  id={roleId}
                  value={role}
                  disabled={sending}
                  onChange={(e) => onRoleChange(e.target.value as InviteRole)}
                  className="w-full appearance-none rounded-md border border-line-strong bg-surface py-2 pl-2.5 pr-8 text-ui text-ink"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <ChevronDown
                  size={14}
                  aria-hidden
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
                />
              </div>
            </div>
          )}
          {mode === 'sso' && (
            <label className="flex h-[38px] items-center gap-2 text-ui text-ink">
              <input
                type="checkbox"
                checked={alsoPassword}
                disabled={sending}
                onChange={(e) => onAlsoPasswordChange(e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
              Also give them a password
            </label>
          )}
        </div>
        {help && <p className="text-meta text-ink-faint">{help}</p>}
      </div>
      {Extras && (
        <SlotBoundary label="invite panel">
          <Extras inviting={validCount} />
        </SlotBoundary>
      )}
    </div>
  );
}

/** How each outcome reads on its row. */
const OUTCOME_BADGE: Record<InviteOutcome['status'], { tone: BadgeTone; label: string }> = {
  created: { tone: 'neutral', label: 'Hasn’t signed in yet' },
  existing: { tone: 'outline', label: 'Already has an account' },
  'no-seat': { tone: 'wait', label: 'Not invited: no seat left' },
  error: { tone: 'danger', label: 'Not invited' },
};

/**
 * An account an admin's promotion found switched off cannot sign in: its row
 * says so, in the waiting tone, rather than "Already has an account" beside
 * a claim that it is ready.
 */
function outcomeBadge(outcome: InviteOutcome): { tone: BadgeTone; label: string } {
  if (outcome.status === 'existing' && outcome.deactivated) return { tone: 'wait', label: 'Account switched off' };
  return OUTCOME_BADGE[outcome.status];
}

/** How the person on one row signs in — or why they can't. */
function outcomeDetail(outcome: InviteOutcome, idp: string): string {
  switch (outcome.status) {
    case 'created': {
      const as = outcome.roleError
        ? `Member: couldn’t make them an admin (${outcome.roleError})`
        : outcome.role === 'admin'
          ? 'Admin'
          : 'Member';
      // Single sign-on is named only where the server said it lets this
      // address in: it refuses one outside the deployment's allowed domains.
      const viaIdp = idp && outcome.singleSignOn ? idp : '';
      const how = outcome.startingPassword
        ? viaIdp
          ? `signs in with ${viaIdp} or the password below`
          : 'signs in with the password below'
        : viaIdp
          ? `signs in with ${viaIdp}`
          : idp
            ? `can’t sign in yet: ${idp} doesn’t accept this address here`
            : null;
      // The deployment emailed them the invite itself (see `wasEmailed`): the
      // row says so first, since it is what the inviter no longer has to do.
      return [wasEmailed(outcome) ? 'Emailed' : null, as, how].filter(Boolean).join(' · ');
    }
    case 'existing': {
      // The invite changed nothing about the account, its password included.
      // Whether it can sign in is not said: the answer is only that it
      // exists, and it may be switched off or have no way in yet. Only a
      // refused promotion tells that it is switched off.
      const access = outcome.deactivated
        ? 'Can’t sign in until it’s switched on in User accounts'
        : 'Left as it was';
      if (outcome.roleError) return `${access}: couldn’t make them an admin (${outcome.roleError})`;
      if (outcome.promoted) return `${access}, now an admin`;
      if (outcome.alreadyAdmin) return `${access}, already an admin`;
      return access;
    }
    case 'no-seat':
    case 'error':
      return outcome.message;
  }
}

const INTRO = 'I’ve added you to our workspace, where we keep what our AI agents should know about the company.';

/**
 * The message to forward, saying how to sign in on this deployment. Never
 * the password: when one was made, it tells them it comes separately.
 */
function inviteMessage(origin: string, how: { idp: string; passwordSet: boolean; passwordSignIn: boolean }): string {
  const { idp, passwordSet, passwordSignIn } = how;
  if (passwordSet && idp) {
    return `${INTRO} Sign in at ${origin} with ${idp}, or with your work email and the password I’ll send you separately (change it on your Account page). Then connect your agent from the welcome page.`;
  }
  if (passwordSet) {
    return `${INTRO} Sign in at ${origin} with your work email and the password I’ll send you separately. Then change it on your Account page and connect your agent from the welcome page.`;
  }
  if (idp) return `${INTRO} Sign in at ${origin} with ${idp}, then connect your agent from the welcome page.`;
  if (passwordSignIn) {
    return `${INTRO} Sign in at ${origin} with your work email and your password, then connect your agent from the welcome page.`;
  }
  return `${INTRO} Sign in with your work account at ${origin}, then connect your agent from the welcome page.`;
}

function InvitedBody({
  outcomes,
  invited,
  methods,
  isAdmin,
}: {
  outcomes: InviteOutcome[];
  invited: number;
  methods: LoginProviders | null;
  /** The inviter's own row says what they are. */
  isAdmin: boolean;
}) {
  const { user } = useAuth();
  const origin = window.location.origin;
  const idp = either(methods?.sso.map((p) => p.label) ?? []);
  // Who got a generated password in this send: the reminder names them when
  // it was not everyone invited, since an existing account got none.
  const gotIt = outcomes.filter(gotPassword).length;
  const passwordSet = gotIt > 0;
  // The deployment emailed EVERY invited person the invite itself (the
  // cloud's mail, say): the inviter has nothing to send. One person it did
  // not reach — an account that was already there, a deployment with no
  // mail — and the message is offered as before, for them.
  const allEmailed = invited > 0 && outcomes.filter(isInvited).every(wasEmailed);
  // Readiness is claimed for the accounts this invite made, and only them:
  // one that was already there is said to exist, not to be able to sign in.
  const created = outcomes.filter((o) => o.status === 'created').length;
  const who = created === invited ? 'They' : 'Everyone with a new account';
  // New accounts with no password that single sign-on refuses (an address
  // outside the deployment's allowed domains): nothing lets them in yet.
  const shutOutEmails = idp
    ? outcomes.filter((o) => o.status === 'created' && !o.startingPassword && !o.singleSignOn).map((o) => o.email)
    : [];
  const shutOut = shutOutEmails.length;
  // The message tells whoever reads it how to sign in, so it is for the
  // people something lets in: never offered to a shut-out account, and it
  // names single sign-on only when it lets in someone it goes to.
  const forwardTo = outcomes.filter((o) => isInvited(o) && !shutOutEmails.includes(o.email));
  const messageIdp = forwardTo.some((o) => o.status !== 'created' || o.singleSignOn) ? idp : '';
  const message = inviteMessage(origin, { idp: messageIdp, passwordSet, passwordSignIn: Boolean(methods?.password) });
  const messageLabel = shutOut > 0 ? `Or send this message to everyone but ${shutOutEmails.join(', ')}` : 'Or send this message';

  return (
    <div className="flex flex-col gap-4 py-1">
      <p className="text-detail text-ink-muted">
        {invited === 0
          ? 'No accounts were created. The reason is on each row.'
          : created === 0
            ? 'They already have accounts, which were left as they were.'
            : shutOut === created
              ? `${created === invited ? 'They' : 'The new accounts'} can’t sign in yet: ${idp} doesn’t accept their addresses here.`
              : shutOut > 0
                ? `Not every new account can sign in yet: ${idp} doesn’t accept some addresses here. Each row says which.`
                : allEmailed
              ? 'They have been emailed the link and how to sign in.'
              : passwordSet
                ? `${who} can sign in now. Send them the link and their password.`
                : idp
                  ? `${who} can sign in now with ${idp}. Send them the link.`
                  : created === invited
                    ? 'Their accounts are ready. Send them the link so they know to sign in.'
                    : 'The new accounts are ready. Send them the link so they know to sign in.'}
      </p>
      <ul aria-label="People" className="flex flex-col divide-y divide-line">
        {user && (
          <PersonRow
            label={`${user.name} (you)`}
            detail={user.email}
            badge={<Badge>{isAdmin ? 'Admin' : 'Member'}</Badge>}
            strong
          />
        )}
        {outcomes.map((outcome) => {
          const badge = outcomeBadge(outcome);
          return (
            <PersonRow
              key={outcome.email}
              label={outcome.email}
              detail={outcomeDetail(outcome, idp)}
              badge={<Badge tone={badge.tone}>{badge.label}</Badge>}
            >
              {outcome.status === 'created' && outcome.startingPassword && (
                <CopyRow
                  label={`Password for ${outcome.email}`}
                  text={outcome.startingPassword}
                  copyLabel="Copy"
                  mono
                  compact
                />
              )}
            </PersonRow>
          );
        })}
      </ul>
      {invited > 0 && (
        <>
          {passwordSet && (
            <Banner tone="wait" role="status" icon={<KeyRound size={16} aria-hidden />}>
              <span className="font-semibold">
                {gotIt === 1
                  ? 'Copy the password on its row now: it isn’t shown again.'
                  : 'Copy each password on its row now: they aren’t shown again.'}
              </span>{' '}
              {allEmailed
                ? 'Send it to them separately if their email didn’t carry it, and ask them to change it on their Account page.'
                : 'Send it to them separately. It isn’t in the message below, so the message is safe to post in a shared channel.'}
            </Banner>
          )}
          <CopyRow label="Where they sign in" text={origin} copyLabel="Copy link" mono />
          {!allEmailed && forwardTo.length > 0 && <CopyRow label={messageLabel} text={message} copyLabel="Copy message" />}
        </>
      )}
    </div>
  );
}

function PersonRow({
  label,
  detail,
  badge,
  strong = false,
  children,
}: {
  label: string;
  detail: string;
  badge: ReactNode;
  strong?: boolean;
  /** Under the row: a created account's generated password. */
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex size-[26px] flex-none items-center justify-center rounded-full border border-line bg-sunken text-micro font-bold text-ink-muted"
        >
          {initials(label)}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-ui text-ink ${strong ? 'font-semibold' : ''}`}>
            {label}
          </span>
          <span className="block truncate text-meta text-ink-faint" title={detail}>
            {detail}
          </span>
        </span>
        {badge}
      </div>
      {children && <div className="pl-[36px]">{children}</div>}
    </li>
  );
}

/**
 * Text to hand on, with its own copy button. The result is said on the
 * button, and a failed copy says what to do instead — the text is on screen
 * to select by hand.
 */
function CopyRow({
  label,
  text,
  copyLabel,
  mono = false,
  compact = false,
}: {
  label: string;
  text: string;
  copyLabel: string;
  mono?: boolean;
  /** Inside a person's row: the label names it for assistive technology only. */
  compact?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className={compact ? 'sr-only' : 'text-detail font-medium text-ink'}>
        {label}
      </span>
      <div className="flex items-stretch overflow-hidden rounded-md border border-line bg-sunken">
        <p
          aria-labelledby={labelId}
          className={`min-w-0 flex-1 px-3 py-2 text-detail text-ink ${mono ? 'truncate font-mono' : 'whitespace-pre-wrap'}`}
        >
          {text}
        </p>
        <button
          type="button"
          aria-label={compact ? `${copyLabel} ${label.charAt(0).toLowerCase()}${label.slice(1)}` : undefined}
          onClick={() => {
            void copyToClipboard(text).then((ok) => setState(ok ? 'copied' : 'failed'));
          }}
          className="flex-none border-l border-line bg-surface px-3 text-detail font-medium text-ink hover:bg-hover"
        >
          {state === 'copied' ? 'Copied' : copyLabel}
        </button>
      </div>
      <span role="status" aria-live="polite" className="text-meta text-ink-faint empty:hidden">
        {state === 'failed' ? 'Couldn’t copy: select the text and copy it yourself.' : ''}
      </span>
    </div>
  );
}
