import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Dialog, type BadgeTone } from '../../../shared/components';
import { SlotBoundary } from '../../../shared/components/SlotBoundary';
import { useAppRegistry } from '../../../core/registry';
import { useAuth } from '../../auth/state/auth.context';
import { createAccount, listAccounts } from '../../auth/services/account.api';
import { addMember } from '../../admin/services/roles.api';
import { copyToClipboard } from '../../library/utils/clipboard';
import { initials } from '../../../lib/email';
import { EmailChipsInput } from './EmailChipsInput';
import {
  isInvited,
  isValidEmail,
  sendInvites,
  splitEmails,
  type InviteOutcome,
  type InviteRole,
} from '../invite-emails';

const ROLE_HINT: Record<InviteRole, string> = {
  member: 'Sees everything shared with the whole workspace.',
  admin: 'Can also change settings and who has access.',
};

/** "1 person" / "3 people" — the one plural this dialog needs. */
function people(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

interface InviteDialogProps {
  open: boolean;
  onClose(): void;
  /** Called after a send that created at least one account. */
  onInvited?(): void;
}

/**
 * Invite your team: addresses in, accounts out — each one waiting for that
 * person's first single sign-on, under the same access rules as everything
 * else (Share → Manage access decides what they then see).
 *
 * Two views in one dialog. The form; then, after sending, who is invited and
 * how to tell them. The second view exists because creating an account sends
 * nobody anything — core has no mail — so the admin leaves with the sign-in
 * address and a message to forward, not with an assumption that people were
 * notified.
 *
 * Feedback stays INSIDE the dialog: the Library's toasts only exist under its
 * own routes, and this opens from Knowledge too.
 */
export function InviteDialog({ open, onClose, onInvited }: InviteDialogProps) {
  const { user } = useAuth();
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [sending, setSending] = useState(false);
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

  async function send() {
    if (valid.length === 0 || sending) return;
    setSending(true);
    try {
      const result = await sendInvites(valid, role, { listAccounts, createAccount, addMember });
      setEmails([]);
      setDraft('');
      setOutcomes(result);
      if (result.some((o) => o.status === 'created')) onInvited?.();
    } finally {
      setSending(false);
    }
  }

  function inviteMore() {
    setEmails([]);
    setDraft('');
    setRole('member');
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
        <InvitedBody outcomes={outcomes} invited={invited} />
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
          <span className="mr-auto self-center text-meta text-ink-faint">
            Uses the same access rules as Share → Manage access.
          </span>
          <Button size="sm" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void send()}
            disabled={valid.length === 0 || sending}
          >
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
        emailsId={emailsId}
        emails={emails}
        onEmailsChange={setEmails}
        draft={draft}
        onDraftChange={setDraft}
        role={role}
        onRoleChange={setRole}
        validCount={valid.length}
        sending={sending}
        placeholder={domain ? `name@${domain}, name@${domain}` : 'name@company.com'}
      />
    </Dialog>
  );
}

function InviteFormBody({
  emailsId,
  emails,
  onEmailsChange,
  draft,
  onDraftChange,
  role,
  onRoleChange,
  validCount,
  sending,
  placeholder,
}: {
  emailsId: string;
  emails: string[];
  onEmailsChange(next: string[]): void;
  draft: string;
  onDraftChange(next: string): void;
  role: InviteRole;
  onRoleChange(next: InviteRole): void;
  validCount: number;
  sending: boolean;
  placeholder: string;
}) {
  const Extras = useAppRegistry().inviteExtras;
  const hintId = useId();
  const roleId = useId();
  const invalidCount = emails.filter((e) => !isValidEmail(e)).length;

  return (
    <div className="flex flex-col gap-4 py-1">
      <p className="text-detail text-ink-muted">
        They sign in with the account for the address you add.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={emailsId} className="text-detail font-medium text-ink">
          Work emails
        </label>
        <EmailChipsInput
          id={emailsId}
          emails={emails}
          onEmailsChange={onEmailsChange}
          draft={draft}
          onDraftChange={onDraftChange}
          placeholder={placeholder}
          aria-describedby={hintId}
          disabled={sending}
        />
        <span id={hintId} className="text-meta text-ink-faint">
          {invalidCount > 0
            ? `${invalidCount === 1 ? 'One address isn’t' : `${invalidCount} addresses aren’t`} valid and won’t be invited.`
            : 'Paste a list, or press Enter or comma after each address.'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <label htmlFor={roleId} className="text-detail text-ink-muted">
          Invite as
        </label>
        <select
          id={roleId}
          value={role}
          disabled={sending}
          onChange={(e) => onRoleChange(e.target.value as InviteRole)}
          className="rounded-md border border-line-strong bg-surface px-2 py-1 text-detail text-ink"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <span className="text-meta text-ink-faint">{ROLE_HINT[role]}</span>
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
  existing: { tone: 'outline', label: 'Already had an account' },
  'no-seat': { tone: 'wait', label: 'Not invited: no seat left' },
  error: { tone: 'danger', label: 'Not invited' },
};

function outcomeDetail(outcome: InviteOutcome): string {
  switch (outcome.status) {
    case 'created':
      if (outcome.roleError) return `Member: couldn’t make them an admin (${outcome.roleError})`;
      return outcome.role === 'admin' ? 'Admin' : 'Member';
    case 'existing':
      return 'Can sign in already';
    case 'no-seat':
    case 'error':
      return outcome.message;
  }
}

function InvitedBody({ outcomes, invited }: { outcomes: InviteOutcome[]; invited: number }) {
  const { user } = useAuth();
  const origin = window.location.origin;
  const message =
    'I’ve added you to our workspace, where we keep what our AI agents should know about the company. ' +
    `Sign in with your work account at ${origin}, then connect your agent from the welcome page.`;

  return (
    <div className="flex flex-col gap-4 py-1">
      <p className="text-detail text-ink-muted">
        {invited === 0
          ? 'No accounts were created. The reason is on each row.'
          : 'Their accounts are ready. Send them the link so they know to sign in.'}
      </p>
      <ul aria-label="People" className="flex flex-col divide-y divide-line">
        {user && (
          <PersonRow
            label={`${user.name} (you)`}
            detail={user.email}
            badge={<Badge>Admin</Badge>}
            strong
          />
        )}
        {outcomes.map((outcome) => {
          const badge = OUTCOME_BADGE[outcome.status];
          return (
            <PersonRow
              key={outcome.email}
              label={outcome.email}
              detail={outcomeDetail(outcome)}
              badge={<Badge tone={badge.tone}>{badge.label}</Badge>}
            />
          );
        })}
      </ul>
      {invited > 0 && (
        <>
          <CopyRow label="Where they sign in" text={origin} copyLabel="Copy link" mono />
          <CopyRow label="Or send this message" text={message} copyLabel="Copy message" />
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
}: {
  label: string;
  detail: string;
  badge: ReactNode;
  strong?: boolean;
}) {
  return (
    <li className="flex items-center gap-2.5 py-2">
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
}: {
  label: string;
  text: string;
  copyLabel: string;
  mono?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-detail font-medium text-ink">
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
