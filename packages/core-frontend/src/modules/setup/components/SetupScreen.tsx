import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { DEFAULT_KB_LAYOUT, type KbLayout } from '@bevel-software/platform-shared';
import { Banner, Button, Surface, TextField } from '../../../shared/components';
import { SlotBoundary } from '../../../shared/components/SlotBoundary';
import { tokenUsernameForHost } from '../utils/git-host';
import { suggestedBranch } from '../utils/suggested-branch';
import { isRootFolderSuggestion, rootFolderState, type RootFolderState } from '../utils/root-folders';
import { copyToClipboard } from '../../../lib/clipboard';
import { GitHubRepositoryPanel } from './GitHubRepositoryPanel';
import { forgetDraft, keepDraft, keptDraft } from '../utils/kept-draft';
import { useAppRegistry } from '../../../core/registry';
import { MarketplaceSection } from '../../settings/components/MarketplaceSection';
import { ConnectionProbeFailed, useConnectionProbe } from '../hooks/useConnectionProbe';
import {
  saveSettings,
  syncNow,
  syncOutcomeError,
  KbInitFailed,
  testOidc,
  RepositoryChangeNeedsConfirmation,
  SettingsProblems,
  type ConnectionTest,
  type KbInitFailure,
  type LastSync,
  type OidcTest,
  type OidcVerification,
  type GitMode,
  type RepositoryChangeChoice,
  type RepositoryChangeResult,
  type RepositoryStatus,
  type SettingStatus,
  type SyncNowResult,
  type SyncStatus,
} from '../services/setup.api';

/** A value to paste elsewhere, with the one button such a value needs. */
function CopyValue({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    // `copyToClipboard` answers false for every ordinary reason a copy does
    // not land (no secure context, no focus, no clipboard at all); the button
    // says so rather than pretending.
    const landed = await copyToClipboard(value);
    setState(landed ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 break-all rounded bg-surface px-2 py-1 font-mono text-meta text-ink">
        {value}
      </code>
      <Button type="button" variant="outline" size="sm" onClick={() => void copy()} aria-label={label}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy'}
      </Button>
    </div>
  );
}

/** "main updated, ali/x up to date" — the per-branch outcomes as one phrase. */
function describeOutcomes(results: LastSync['results']): string {
  if (results.length === 0) return 'nothing to update yet';
  const word = (r: LastSync['results'][number]): string => {
    switch (r.outcome) {
      case 'up-to-date':
        return 'up to date';
      case 'not-cloned':
        return 'not set up on this server yet';
      case 'remote-gone':
        return 'deleted on the host';
      default:
        return r.outcome;
    }
  };
  return results.map((r) => `${r.branch} ${word(r)}`).join(', ');
}

/** Copy for each setting: what it is, in the words of someone who has to fill it in. */
const FIELDS: Record<
  string,
  {
    label: string;
    help: string;
    placeholder?: string;
    advanced?: boolean;
    /** An on/off setting, shown as a checkbox and saved as `true` / `false`; `on` is what an unset one means. */
    toggle?: { on: boolean };
  }
> = {
  kbRepoUrl: {
    label: 'Repository address',
    help: 'Where your knowledge, skills and tools are stored. Copy the address from your repository page: GitHub, GitLab, Bitbucket and Azure DevOps all work. A brand-new empty repository is fine.',
    placeholder: 'https://github.com/acme/knowledge-base.git',
  },
  gitToken: {
    label: 'Access token',
    help: 'Lets this deployment read and write that repository. Create one in your git provider with read and write access to it. Stored encrypted, and never shown again.',
    placeholder: 'Paste the token',
  },
  gitUsername: {
    // NOT a person's username — the previous label said "Token username" and
    // people read it as their own account. It is a fixed string each host
    // expects beside a token, so it is filled in automatically and only
    // surfaces under Advanced for hosts we cannot recognise.
    label: 'Token username',
    help: 'A fixed value the git host expects next to the token, not your account name. Filled in automatically for known hosts; only change it for a self-hosted server.',
    placeholder: 'x-access-token',
    advanced: true,
  },
  kbDirName: {
    label: 'Folder name',
    help: 'What the repository folder is called inside each workspace. Cosmetic; leave it as it is.',
    placeholder: 'knowledge-base',
    advanced: true,
  },
  kbSyncSecret: {
    label: 'Hook secret',
    help: 'Lets your git host tell this deployment when the repository changes, so changes made there show up here right away. Add a webhook, action or pipeline step that calls POST /api/sync/<branch> with this value as a bearer token. Optional: without it, only an administrator can bring in updates. Stored encrypted, and never shown again.',
    placeholder: 'A long random string',
    advanced: true,
  },
  // The three roots are NOT under Advanced: a repository whose skills live in
  // `skills/` connected fine, got an empty `Skills/` scaffolded beside it and
  // imported nothing — a choice that has to be seen to be made.
  knowledgeBaseDir: {
    label: 'Knowledge folder',
    help: 'The top-level folder in the repository that holds the knowledge. Change it only to read a repository laid out by someone else.',
    placeholder: 'KnowledgeBase',
  },
  skillsDir: {
    label: 'Skills folder',
    help: 'The top-level folder that holds shared skills. The three folder names must differ. Case matters: skills and Skills are different folders.',
    placeholder: 'Skills',
  },
  pluginsDir: {
    label: 'Plugins folder',
    help: 'The top-level folder that holds plugins. The three folder names must differ.',
    placeholder: 'Plugins',
  },
  defaultBranch: {
    label: 'Main branch',
    help: 'The version everyone sees. Filled in from your repository when you test the connection.',
    placeholder: 'main',
    advanced: true,
  },
  protectedBranches: {
    label: 'Branches that need approval',
    help: 'Nobody can change these directly; edits arrive as a request someone approves. Separate several with commas. The main branch has to be one of them.',
    placeholder: 'main',
    advanced: true,
  },
  retireMergedBranches: {
    label: 'Remove branches left over from merged change requests',
    help: 'Removes, on its own, a draft whose change request was merged but which is still there: every commit on it is already on the main branch and no request is open from or into it. Runs at startup and whenever the server checks for deleted branches. Merging a change request removes its draft either way. Applies without a restart.',
    advanced: true,
    toggle: { on: true },
  },
  oidcIssuerUrl: {
    label: 'Provider address',
    help: 'From your identity provider. Entra, Okta, Google Workspace, Auth0 and others all publish one.',
    placeholder: 'https://login.microsoftonline.com/<tenant>/v2.0',
  },
  oidcClientId: {
    label: 'Application ID',
    help: 'From the application you registered with the provider.',
  },
  oidcClientSecret: {
    label: 'Application secret',
    help: 'Issued alongside the application ID. Stored encrypted, and never shown again.',
  },
  oidcScopes: {
    label: 'Scopes',
    help: 'Leave blank unless your provider asked for something specific.',
    placeholder: 'openid profile email',
    advanced: true,
  },
  oidcProviderLabel: {
    label: 'Sign-in button text',
    help: 'What the button on the sign-in page says.',
    placeholder: 'Single sign-on',
    advanced: true,
  },
  allowedEmailDomains: {
    label: 'Allowed email domains',
    help: 'Only people with an address at these domains can sign in through this provider. Separate several with commas. Leave blank to allow any address: safe with a provider that only serves your organisation, risky with one that does not.',
    placeholder: 'example.com',
  },
  auditRetentionDays: {
    label: 'Keep events for',
    help: 'How many days an agent’s recorded calls stay in the Audit log before they are removed. Leave it blank, or enter 0, to keep them forever. Applies without a restart.',
    placeholder: 'forever',
  },
};

/**
 * What the deployment cannot start without — the same four the server's
 * `isComplete` checks. Named here so a save that lands but leaves setup
 * unfinished can say WHICH answer is still missing, rather than returning a
 * blank form and letting the reader guess.
 */
const REQUIRED_KEYS = ['kbRepoUrl', 'gitToken', 'defaultBranch', 'protectedBranches'];

/** The half of those every deployment owes, however it has its repository. */
const BRANCH_MODEL_KEYS = ['defaultBranch', 'protectedBranches'];

/** What each way of having a repository is called on its tab. */
const GIT_MODE_LABEL: Record<GitMode, string> = {
  managed: 'Hexis takes care of it',
  'github-app': 'GitHub',
  token: 'Address and token',
};

/**
 * The answers a connection test actually proves — the address, the credential
 * and the name that goes beside it.
 *
 * Editing one invalidates the result on screen, because it described the old
 * ones. Editing anything ELSE leaves it standing: whether a repository is
 * reachable has nothing to do with an identity provider's scopes, and clearing
 * it there would ask an admin to prove the same repository twice.
 */
const CONNECTION_KEYS = ['kbRepoUrl', 'gitToken', 'gitUsername'];

/**
 * The settings each way of having a repository is answered by, on its tab.
 * What belongs to a tab is sent only while that tab is open, and a refusal
 * about it opens that tab.
 */
const TAB_KEYS: Record<GitMode, readonly string[]> = {
  managed: [],
  'github-app': ['githubRepository'],
  token: CONNECTION_KEYS,
};

/**
 * The answers the sign-in check proves. Editing one invalidates its result on
 * screen; the scopes, the button text and the allowed domains are not among
 * them, and the server never re-checks a save that changes only those.
 */
const OIDC_KEYS = ['oidcIssuerUrl', 'oidcClientId', 'oidcClientSecret'];

/** How the configuration in effect is labelled, in both variants. */
const OIDC_VERIFICATION_LABEL: Record<OidcVerification, string> = {
  verified: 'Verified',
  unverified: 'Unverified — sign in once to confirm',
  'not-configured': 'Not configured',
  unrecordable: 'Not recorded — set SECRETS_ENC_KEY to keep verification',
};

/** The three root folder fields, checked against the repository's listing. */
const ROOT_FOLDER_KEYS = ['knowledgeBaseDir', 'skillsDir', 'pluginsDir'] as const;
const isRootFolderKey = (key: string): key is (typeof ROOT_FOLDER_KEYS)[number] =>
  (ROOT_FOLDER_KEYS as readonly string[]).includes(key);

/**
 * The knowledge-base LAYOUT fields — the three folders — which render
 * together, under the connection test whose listing they are checked
 * against, rather than with the connection fields above it. (The guide's
 * file name was one of them while the guide was written to disk; it is
 * served by the platform now and has no field.)
 */
const LAYOUT_KEYS: readonly (keyof KbLayout)[] = [...ROOT_FOLDER_KEYS];
const isLayoutKey = (key: string): boolean => (LAYOUT_KEYS as readonly string[]).includes(key);

/** How a near-miss folder differs from the configured name, as the warning words it. */
const VARIANT_DIFFERENCE: Record<Extract<RootFolderState, { kind: 'variant' }>['difference'], string> = {
  case: 'differs only by case',
  'trailing-s': 'differs only by a trailing s',
  'case-and-trailing-s': 'differs by case and a trailing s',
};

/** The blocks, in the order they are worked through. */
const SECTIONS: { id: SettingStatus['section']; title: string; blurb: string }[] = [
  {
    id: 'knowledge-base',
    title: 'Knowledge, skills & tools',
    blurb:
      'Where everything lives, together in one git repository: knowledge, skills and tools. Connect one (an empty repository is fine, it will be set up for you) and test it; the rest fills itself in.',
  },
  {
    id: 'sign-in',
    title: 'Single sign-on',
    blurb:
      'Optional, and you can add it later. Lets people sign in with the account they already have instead of a password.',
  },
  {
    id: 'audit',
    title: 'Audit log',
    blurb:
      'The Audit log records which tools, skills and capabilities each connected agent uses. Choose how long those records are kept; unset, they are kept forever.',
  },
];

/**
 * What the first run asks: where the knowledge lives, which the gate waits
 * on, and how people sign in, which decides who can follow the admin in.
 * Everything else is a preference with a working default. It is set on the
 * Deployment page, by someone who has seen the product it configures; on the
 * first screen it only made two questions look like five.
 */
const FIRST_RUN_SECTIONS: readonly SettingStatus['section'][] = ['knowledge-base', 'sign-in'];

/** The two ways of signing in the section can show, when the distribution runs one. */
type SignInTab = 'managed' | 'own';

/**
 * A section's fields. Alone in their section they are its content as it has
 * always been; beside a distribution's tab they are the panel of theirs, so
 * the tab that names them has something to name.
 */
function SectionFields({
  panel,
  children,
}: {
  /** The tab these fields are the panel of: which set of tabs, and which one. Null: no tabs. */
  panel: { group: 'sign-in' | 'repository'; id: string } | null;
  children: ReactNode;
}) {
  if (panel === null) return <>{children}</>;
  return (
    <div
      role="tabpanel"
      id={`${panel.group}-panel-${panel.id}`}
      aria-labelledby={`${panel.group}-tab-${panel.id}`}
      className="space-y-6"
    >
      {children}
    </div>
  );
}

/**
 * The distribution's panel sits inside the settings form, and a browser
 * submits a form when Enter is pressed in any text input in it. On first
 * run that submit finishes setup and leaves the screen, from a field that
 * had nothing to do with it. Held here once, so no panel has to remember:
 * Enter in one of its inputs is the panel's own key. A text area keeps its
 * new line and a button its press, neither of which submits anything.
 */
function keepEnterFromTheForm(event: KeyboardEvent<HTMLElement>) {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
}

interface Props {
  settings: SettingStatus[];
  /**
   * Re-read the status after a save, so the gate can let the app through.
   *
   * The host must let only its LATEST read land (`SetupGate` and
   * `DeploymentPage` both read through `useSetupStatus`, which does): each
   * fresh `kbInit` replaces the failure on
   * screen, so an earlier read answering late — the refresh after a failed
   * save, landing after a retry that succeeded — would otherwise put the
   * cleared failure back.
   */
  onSaved(): void;
  /**
   * Where the screen is standing. `setup` (the default) is the first-run
   * gate: full-page chrome, its own heading. `settings` is the SAME form
   * embedded in the admin Deployment page — the host owns the chrome and the
   * words around it, so the wrapper and heading stay out of the way. One
   * component on purpose: the fields, the env-lock rule, the connection test
   * and the restart banners must never drift between first run and later.
   */
  variant?: 'setup' | 'settings';
  /**
   * The remote-sync facts to show beside the sync secret: the address a hook
   * calls, and what the last call did. Absent on a build without the module.
   */
  sync?: SyncStatus;
  /**
   * A standing knowledge-base initialization failure, from the status
   * endpoint — so the banner is there when the screen is opened, not only
   * right after the save that failed.
   */
  kbInit?: KbInitFailure;
  /** Whether the single sign-on configuration in effect is proven. Absent from an older server. */
  oidcVerification?: OidcVerification;
  /**
   * The ways this deployment can have its repository, and the one it is on.
   * Absent from a server that knows one way only: the address and the token,
   * drawn as they always were, with no tabs.
   */
  repository?: RepositoryStatus;
}

/**
 * First-run setup: the one screen standing between a fresh deployment and a
 * working one.
 *
 * WHY IT EXISTS AT ALL. Every value here used to be an environment variable
 * that had to be right before the server would start — which meant the first
 * feedback on a wrong token was a failed clone some minutes later, in a log.
 * A form can do the thing an environment variable never can: ask the remote
 * whether the answer is right, and say which part was wrong.
 *
 * WHAT IT DOES NOT DO. It never displays a stored secret, and it does not let
 * anyone overwrite a value the environment supplies — those fields render as
 * locked, naming the variable to change instead. That keeps a browser from
 * silently outranking the infrastructure config someone is reviewing in a
 * repo, which is the same rule the server enforces.
 */
/** Two reports of the same initialization failure (a status read builds a new object each time). */
function sameFailure(a: KbInitFailure, b: KbInitFailure): boolean {
  return a.kind === b.kind && a.cause === b.cause;
}

export function SetupScreen({
  settings,
  onSaved,
  variant = 'setup',
  sync,
  kbInit,
  oidcVerification,
  repository,
}: Props) {
  /** Whether a setting is a secret: what is never written to the browser's storage. */
  const isSecret = (key: string) => settings.find((s) => s.key === key)?.secret !== false;
  /**
   * What was typed before the browser left for GitHub, put back now that it
   * has returned (see `kept-draft.ts`). Only on a return from GitHub, which
   * the address says: what was kept for a trip that was abandoned is not
   * sprung on someone who opens the screen later. And only for settings
   * that are still this form's to edit.
   */
  const [restored] = useState(() => {
    const back = new URLSearchParams(window.location.search ?? '').has('github');
    const kept = back ? keptDraft(isSecret) : { draft: {}, dropped: [] };
    const editableNow = (key: string) => settings.some((s) => s.key === key && s.source !== 'env');
    return {
      draft: Object.fromEntries(Object.entries(kept.draft).filter(([key]) => editableNow(key))),
      dropped: kept.dropped.filter(editableNow),
    };
  });
  // Read once, then gone: in an effect, since the page may be built twice
  // before it is shown and must find the same thing both times.
  useEffect(() => forgetDraft(), []);
  const [draft, setDraft] = useState<Record<string, string>>(restored.draft);
  /** The secrets that were typed before the trip and not kept, until each is entered again. */
  const toEnterAgain = restored.dropped.filter((key) => !draft[key]?.trim());
  /**
   * The initialization failure on screen: the status endpoint's, until a save
   * or a retry from this screen answers more recently. A fresh status read
   * (a new `kbInit` from the host) takes over again — adjusted during render
   * rather than in an effect, so the stale banner never paints. That a fresh
   * prop really is the latest read is the host's promise (see `onSaved`), and
   * each retry or save that clears the failure here also asks for that read.
   */
  const [initFailure, setInitFailure] = useState<KbInitFailure | null>(kbInit ?? null);
  const [seenKbInit, setSeenKbInit] = useState(kbInit);
  /**
   * The failure a save or retry from THIS screen has just seen cleared, until a
   * status read agrees. A read that went out before the retry — the refresh
   * after the failed save — can still answer after it, reporting that same
   * failure as standing; this screen knows better, so the stale copy is not
   * shown. The guard lifts on the first read without a failure, and never
   * hides a DIFFERENT failure: that is news, whenever it arrives.
   */
  const [clearedFailure, setClearedFailure] = useState<KbInitFailure | null>(null);
  if (kbInit !== seenKbInit) {
    setSeenKbInit(kbInit);
    if (!kbInit) {
      setClearedFailure(null);
      setInitFailure(null);
    } else if (!(clearedFailure && sameFailure(kbInit, clearedFailure))) {
      setClearedFailure(null);
      setInitFailure(kbInit);
    }
  }
  /**
   * The move to another repository the server has REFUSED until it is
   * confirmed: how many change requests were open at that moment, and the
   * way left and the way moved to when the server tells them apart. Null
   * when there is nothing to confirm.
   *
   * THE ONE QUESTION A MOVE IS ASKED, whichever kind it is: another address,
   * another repository on GitHub, another way of having one. The server
   * decides what is a move, so the screen does not guess at it beforehand.
   *
   * Nothing was saved and nothing was destroyed while this stands: the answer
   * is a decision only the admin can make, and the draft is kept exactly as
   * typed so the confirmed save re-sends it.
   */
  const [repositoryChange, setRepositoryChange] = useState<{
    openChangeRequests: number;
    from?: GitMode;
    to?: GitMode;
    /** The move the question was asked about, so it is not shown for another one. */
    target: string;
  } | null>(null);
  /** What to do with the open change requests. Keeping them is the safe default: nothing closes by hesitating. */
  const [changeChoice, setChangeChoice] = useState<RepositoryChangeChoice>('keep');
  /** What the save that changed the repository did, so the screen can say so afterwards. */
  const [repositoryChanged, setRepositoryChanged] = useState<RepositoryChangeResult | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  /** What the last "Update now" from THIS page came back with (a failure to ask is `error`). */
  const [syncResult, setSyncResult] = useState<SyncNowResult | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  /** Required answers still missing after a save that otherwise succeeded. */
  const [stillMissing, setStillMissing] = useState<string[]>([]);
  /** Answered, yet this process is still running on the old branch model. */
  const [needsRestart, setNeedsRestart] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  /**
   * The connection test: what the host last said about the answers on screen,
   * cleared by an edit to one of them, with an answer that lands after such
   * an edit held stale rather than shown. The probe is the one mechanism for
   * it, shared with the first-run storage screen.
   */
  const probe = useConnectionProbe();
  const { result: test, testing } = probe;
  const [oidcTest, setOidcTest] = useState<OidcTest | null>(null);
  const [oidcTesting, setOidcTesting] = useState(false);
  /** The probe's staleness guard, for the sign-in answers: a result describes the answers as they were when the request left. */
  const oidcEpoch = useRef(0);
  /**
   * A verification state newer than the one the host last passed in — what a
   * save or a test just answered. Dropped for good the moment the host passes
   * in anything new (its own refresh supersedes it, even one that comes back
   * to the value it replaced) and when a sign-in field is edited.
   */
  const [latest, setLatest] = useState<OidcVerification | null>(null);
  const [hostVerification, setHostVerification] = useState(oidcVerification);
  if (hostVerification !== oidcVerification) {
    // Adjusting state to a changed prop during render, rather than in an
    // effect: React re-renders at once, before anything stale is painted.
    setHostVerification(oidcVerification);
    setLatest(null);
  }
  const verification = latest ?? oidcVerification;

  /**
   * What a field would save as, given a set of typed answers: what is in them,
   * else what is already stored. Taken over a payload rather than the draft
   * alone so a submit can ask about values it has just derived, which `draft`
   * will not hold until the next render.
   */
  const resolvedIn = (typed: Record<string, string>, key: string) =>
    (typed[key] ?? settings.find((s) => s.key === key)?.value ?? '').trim();

  /** What a field would save as: what was typed, else what is already stored. */
  const resolved = (key: string) => resolvedIn(draft, key);

  const editable = settings.filter((s) => s.source !== 'env');
  const fromEnv = settings.filter((s) => s.source === 'env');
  const sections = variant === 'setup' ? SECTIONS.filter((s) => FIRST_RUN_SECTIONS.includes(s.id)) : SECTIONS;

  /**
   * The distribution's own way of signing in, when it runs one, and which of
   * the two tabs is open. The section opens on the way that is in effect: the
   * deployment's own provider once it has one, the distribution's until then.
   * Chosen once, from what was stored when the screen opened, so typing an
   * issuer does not move the reader to another tab.
   */
  const { signInOption } = useAppRegistry();
  const ownProviderConfigured = OIDC_KEYS.every((key) => settings.find((s) => s.key === key)?.configured === true);
  const [signInTab, setSignInTab] = useState<SignInTab>(
    // What was being typed about the deployment's own provider is shown, not put back out of sight.
    ownProviderConfigured || [...Object.keys(restored.draft), ...restored.dropped].some((key) => OIDC_KEYS.includes(key))
      ? 'own'
      : 'managed',
  );

  /**
   * The way the deployment has its repository, and which one's tab is open.
   * THE TAB IS THE CHOICE: what is open when Save is pressed is what the
   * deployment is on afterwards. It opens on the way CHOSEN, so a
   * deployment that is configured stays as it is unless its admin opens
   * another tab, and on the first way offered for one that has none.
   * Absent from a server that knows one way only, which is then the only
   * thing drawn.
   *
   * Two ways are told apart: the one IN EFFECT, which the running
   * deployment is on, and the one chosen. A move takes effect on the save
   * that confirms it, so they differ only where the server reports a choice
   * it has not put in effect, which a restart then does.
   */
  const inEffect = repository?.mode ?? null;
  const chosen = repository ? (repository.chosen ?? repository.mode) : null;
  const [gitTab, setGitTab] = useState<GitMode>(() => {
    // Back from a round trip to GitHub: that tab is where it started, and
    // where what came of it is said.
    const backFromGitHub =
      !repository?.pinned &&
      repository?.modes.includes('github-app') &&
      new URLSearchParams(window.location.search ?? '').has('github');
    return backFromGitHub ? 'github-app' : (chosen ?? repository?.modes[0] ?? 'token');
  });
  /** The tab a setting is answered on, for the ones that belong to one way of having a repository. */
  const tabOf = (key: string): GitMode | null =>
    repository ? ((Object.keys(TAB_KEYS) as GitMode[]).find((mode) => TAB_KEYS[mode].includes(key)) ?? null) : null;
  /** Whether the repository is reached by an address and a token: the fields, the test, the proof. */
  const byAddress = !repository || gitTab === 'token';
  /** A way was chosen that the server has not put in effect: the deployment is still on the way it was. */
  const movePending = inEffect !== null && chosen !== inEffect;
  /**
   * Saving NOW would choose another way than the one chosen, on a deployment
   * that has a repository: a move, or a move taken back. Said on the tab
   * before the button is pressed; the question itself is the server's, asked
   * when the save arrives, because an open tab is not a decision.
   */
  const savingMoves = inEffect !== null && gitTab !== chosen;
  const movingFrom = inEffect ? GIT_MODE_LABEL[inEffect] : '';
  /**
   * What a move is a move TO, as far as the screen can tell: the tab, and
   * the address or the repository on GitHub typed on it.
   */
  const moveTarget = [gitTab, draft.kbRepoUrl ?? '', draft.githubRepository ?? ''].join('\n');
  /**
   * The question, while it is still about the move on screen. A yes to one
   * move is not a yes to another: another tab, another address or another
   * repository on GitHub is another move, and the next save asks afresh.
   */
  const moveAsked = repositoryChange?.target === moveTarget ? repositoryChange : null;

  /**
   * What a save sends about the repository, given what was typed: the way
   * chosen, when it is not the one in effect, and only the answers of the
   * tab that is open. Something entered on a tab that was then left is not
   * an answer, and must not be stored beside the choice of another.
   */
  function chosenRepository(typed: Record<string, string>): Record<string, string> {
    if (!repository) return typed;
    const kept = Object.fromEntries(
      Object.entries(typed).filter(([key]) => {
        const tab = tabOf(key);
        return tab === null || tab === gitTab;
      }),
    );
    // Against the way CHOSEN: a move that is pending was already sent, and
    // opening the tab of the way in effect is how it is taken back.
    return gitTab === chosen ? kept : { ...kept, gitMode: gitTab };
  }

  /**
   * Whether the form has a place for this field at all: it is the admin's to
   * edit, and its section is one this variant shows. A field on a tab that
   * is not open still counts — the tab is opened for it (see
   * `showProblems`), where a field the form never draws has nowhere to be
   * shown.
   */
  const hasPlace = (key: string) =>
    // A setting with no field of its own (the way the repository is had,
    // which is chosen by its tab) has nowhere to hold a message. The
    // repository on GitHub has one, drawn by that tab's panel.
    (FIELDS[key] !== undefined || (key === 'githubRepository' && !!repository?.modes.includes('github-app'))) &&
    editable.some((s) => s.key === key && sections.some((section) => section.id === s.section));

  /**
   * Put a refused save's problems where the reader will see them. EVERY
   * problem ends up on screen, which is the one property this function is
   * for: one about a field the form draws goes beside that field, with the
   * tab it lives on opened; one about a field the form does not draw goes
   * to the message line. A save that failed must never look like a save
   * that did nothing.
   */
  function showProblems(found: Record<string, string>) {
    setProblems(found);
    const placed = Object.keys(found).filter(hasPlace);
    if (signInOption && placed.some((key) => settings.find((s) => s.key === key)?.section === 'sign-in')) {
      setSignInTab('own');
    }
    const owner = placed.map(tabOf).find((tab) => tab !== null);
    if (owner) setGitTab(owner);
    const unplaced = Object.entries(found).filter(([key]) => !hasPlace(key));
    if (unplaced.length > 0) setError(unplaced.map(([, message]) => message).join(' '));
  }

  /**
   * Whether saving now would actually change this connection field: something
   * non-blank was typed, and it is not the stored value typed back in. Secrets
   * have no stored value to show, so any non-blank entry counts as a change —
   * which is right, because it replaces the stored one.
   */
  const connectionKeyChanged = (key: string) => {
    const typed = draft[key]?.trim();
    if (!typed) return false;
    return typed !== (settings.find((s) => s.key === key)?.value ?? '').trim();
  };

  /**
   * Something typed that a save would actually store. The retry sends an EMPTY
   * save — pressed now, it would re-run against the stored values while a
   * corrected token sits unsaved in the form — so it waits, and Save (which
   * retries too) is the way to try with the new values. Judged like the
   * connection gate above — an edit put back changes nothing — and a token
   * username that is just what an address answers (the one typed, or the one
   * stored) is not an edit of its own: typing the address fills it in, and once
   * the address is put back or cleared, nothing the admin did is left unsaved.
   */
  const answeredUsernames = [draft.kbRepoUrl, settings.find((s) => s.key === 'kbRepoUrl')?.value].map(
    (address) => (address ? tokenUsernameForHost(address)?.username : undefined),
  );
  const draftChanged = Object.keys(draft).some(
    (key) =>
      !(key === 'gitUsername' && answeredUsernames.includes(draft.gitUsername)) &&
      connectionKeyChanged(key),
  );

  /**
   * Whether THIS save has to stand behind the repository connection.
   *
   * On first run it always does: everything behind the gate reads from a
   * repository that has to be reachable, and the save that finishes setup is
   * what opens that gate. On the Deployment page only a save that CHANGES the
   * connection does — an admin editing single sign-on has no repository to
   * re-prove, and refusing them over a token that expired somewhere else helps
   * nobody.
   *
   * "Changes" means the value the save would store differs from the stored
   * one — a field someone touched and then restored changes nothing, and a
   * blank field means "leave it alone", not "clear it". Judging by "was it
   * typed in" held saves hostage to edits that no longer exist.
   *
   * There is nothing to prove until there is an address to prove it against; a
   * blank form is the server's to complain about, field by field.
   */
  const mustProveConnection =
    // A repository the deployment keeps has no host to prove anything to.
    byAddress &&
    !!resolved('kbRepoUrl') &&
    (variant === 'setup' || CONNECTION_KEYS.some((key) => connectionKeyChanged(key)));

  /**
   * The host was asked about the answers currently on screen, and said no.
   * Editing any of them clears the result, so this is never about a value the
   * reader has already changed.
   */
  const connectionRejected = mustProveConnection && test?.ok === false;
  /** Of those, the host let the token read but not write — a different fix. */
  const connectionReadOnly = connectionRejected && test?.outcome === 'read-only';

  function set(key: string, value: string) {
    setDraft((d) => {
      const next = { ...d, [key]: value };
      // Typing the repository address answers the token-username question, so
      // it is not asked. Only filled while the operator has not set one
      // themselves — a self-hosted server they typed a value for must not be
      // overwritten by a guess from its domain.
      if (key === 'kbRepoUrl' && !d.gitUsername) {
        const known = tokenUsernameForHost(value);
        if (known) next.gitUsername = known.username;
      }
      return next;
    });
    // The message described the old value; keeping it beside a new one would
    // be a complaint about something the reader already fixed.
    setProblems((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (OIDC_KEYS.includes(key)) {
      oidcEpoch.current++;
      setOidcTest(null);
      // A test's "Verified" was about the values before this edit.
      setLatest(null);
    }
    // Any in-flight test is now asking about values that are gone; its answer
    // lands as stale rather than as evidence.
    if (CONNECTION_KEYS.includes(key)) probe.invalidate();
  }

  /**
   * Ask the remote, record what it said, and fill the version fields in from
   * it. The repository has just said what it calls its trunk and which
   * branches it has; filling those in beats asking someone to remember, and
   * beats the silent failure of a name that is one character off. Only into
   * fields nobody has answered — never over a name somebody typed.
   *
   * ONE function for both callers — the Test button, and a Save that has to
   * prove the connection before storing it — because two copies of "which
   * branch did it name?" is how the two answers drift apart. It returns what
   * it derived as well as the result, so a submit can use both without waiting
   * for a re-render.
   */
  async function probeConnection(): Promise<{
    result: ConnectionTest;
    derived: Record<string, string>;
  }> {
    // The result describes the connection values as they were when the
    // request left. Edited while it was out, it is stale: the probe never
    // shows it, and it comes back to the caller, whose payload is the same
    // snapshot. `derived` is likewise computed against that snapshot, because
    // it travels with the payload.
    const { result, stale } = await probe.ask(draft);
    const suggested = result.ok ? suggestedBranch(result) : null;
    const derived: Record<string, string> = {};
    if (suggested) {
      if (!resolved('defaultBranch')) derived.defaultBranch = suggested;
      if (!resolved('protectedBranches')) derived.protectedBranches = suggested;
    }
    if (!stale && suggested) {
      // Re-check against the LATEST draft, not the snapshot: a branch name
      // typed while the request was in flight is an answer, and a suggestion
      // must never overwrite an answer.
      setDraft((d) => {
        const next = { ...d };
        if (!resolvedIn(d, 'defaultBranch')) next.defaultBranch = suggested;
        if (!resolvedIn(d, 'protectedBranches')) next.protectedBranches = suggested;
        return next;
      });
    }
    return { result, derived };
  }

  async function runTest() {
    setError(null);
    try {
      await probeConnection();
    } catch (err) {
      // A FAILURE goes stale the same way a success does: if the connection
      // was edited while this request was out, the error describes values no
      // longer on screen, and showing it would complain about something the
      // reader already changed.
      if (!(err instanceof ConnectionProbeFailed) || !err.stale) {
        setError(err instanceof Error ? err.message : 'Could not test the connection.');
      }
    }
  }

  /**
   * "Test sign-in configuration": the check a save runs, on the values typed
   * (the server falls back to those in effect). Nothing is saved.
   */
  async function runOidcTest() {
    setOidcTesting(true);
    setError(null);
    const epoch = oidcEpoch.current;
    const fields = Object.fromEntries(Object.entries(draft).filter(([key]) => OIDC_KEYS.includes(key)));
    try {
      const result = await testOidc(fields);
      if (epoch !== oidcEpoch.current) return;
      setOidcTest(result);
      if (result.oidcVerification) setLatest(result.oidcVerification);
    } catch (err) {
      if (epoch === oidcEpoch.current) {
        setOidcTest({ ok: false, error: err instanceof Error ? err.message : 'Could not test the sign-in configuration.' });
      }
    } finally {
      setOidcTesting(false);
    }
  }

  /** What a sign-in test came back with, in words. */
  function describeOidcTest(result: OidcTest): string {
    switch (result.outcome) {
      case 'verified':
        return 'Verified. The provider accepted the application ID and secret.';
      case 'issuer-verified':
        return 'The provider address is a sign-in provider. Enter the application ID and secret to check them too.';
      default:
        return result.error ?? 'The sign-in configuration could not be checked.';
    }
  }

  /**
   * The test button, its answer and the verification label: beside the
   * provider fields, or on its own when every one of them is set by the
   * environment.
   */
  function renderOidcPanel() {
    return (
      <Surface tone="sunken" radius="md" className="p-4">
        {verification && (
          <p className="mb-3 text-detail text-ink-muted">
            Status:{' '}
            <span
              data-testid="oidc-verification"
              className={`font-medium ${
                verification === 'verified'
                  ? 'text-ok'
                  : verification === 'unverified'
                    ? 'text-wait'
                    : 'text-ink-faint'
              }`}
            >
              {OIDC_VERIFICATION_LABEL[verification]}
            </span>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void runOidcTest()}
            disabled={oidcTesting || saving}
          >
            {oidcTesting ? 'Checking…' : 'Test sign-in configuration'}
          </Button>
          <span className="text-meta text-ink-faint">
            Checks the provider address, then the application ID and secret, with the provider.
          </span>
        </div>
        {oidcTest && (
          <p
            role="status"
            className={`mt-3 text-detail ${
              oidcTest.ok ? 'text-ok' : oidcTest.outcome === 'unverified' ? 'text-wait' : 'text-danger'
            }`}
          >
            {describeOidcTest(oidcTest)}
          </p>
        )}
      </Surface>
    );
  }

  async function runSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      setSyncResult(await syncNow());
      // The status carries the last-sync record; refetch so it shows this one.
      onSaved();
    } catch (err) {
      setSyncResult({
        ok: false,
        results: [],
        error: err instanceof Error ? err.message : 'Couldn’t get the latest changes.',
      });
    } finally {
      setSyncing(false);
    }
  }

  /**
   * Beside the sync secret: the address a hook calls (in both variants — an
   * admin wiring a hook needs it before first run too), and once the
   * deployment is live, what the last call did plus a button to make one.
   */
  function renderSyncPanel() {
    if (!sync) return null;
    const last = sync.last;
    return (
      <Surface tone="surface" radius="md" className="mt-3 space-y-3 border border-line p-3">
        <div className="space-y-1.5">
          <span className="text-meta font-medium text-ink">Address for the hook</span>
          <CopyValue value={`${sync.url}/<branch>`} label="Copy the hook address" />
          <p className="text-meta text-ink-faint">
            Replace <code className="font-mono">&lt;branch&gt;</code> with the branch that changed;
            send the secret as a bearer token.
          </p>
        </div>
        {variant === 'settings' && (
          <div className="space-y-2">
            <p role="status" className="text-meta text-ink-muted">
              {last
                ? `Last update ${new Date(last.at).toLocaleString()} by ${last.by}: ${describeOutcomes(last.results)}.`
                : 'No updates since this server started.'}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runSync()}
                disabled={syncing}
              >
                {syncing ? 'Updating…' : 'Update now'}
              </Button>
              <span className="text-meta text-ink-faint">
                Gets the latest changes from your git host now, the same as the hook does.
              </span>
            </div>
            {syncResult && (
              <p
                role="status"
                // One line per failed branch: the server's sentences are
                // joined with newlines and rendered as such.
                className={`whitespace-pre-line text-detail ${syncResult.ok ? 'text-ok' : 'text-danger'}`}
              >
                {syncResult.error
                  ? syncResult.error
                  : syncResult.ok
                    ? `Updated: ${describeOutcomes(syncResult.results)}.`
                    : (syncResult.results
                        .map(syncOutcomeError)
                        .filter((e): e is string => !!e)
                        .join('\n') ||
                      `Not fully updated: ${describeOutcomes(syncResult.results)}.`)}
              </p>
            )}
          </div>
        )}
      </Surface>
    );
  }

  /**
   * Re-run the knowledge-base initialization. No endpoint of its own: any save
   * while the failure stands re-runs the phase, and an EMPTY one changes no
   * setting — so nothing has to be typed again, and the server's one-save-at-a-
   * time chain covers this exactly as it covers the form.
   */
  async function retryInitialization() {
    if (retrying || saving || draftChanged) return;
    setRetrying(true);
    setError(null);
    try {
      const result = await saveSettings({});
      setClearedFailure(initFailure);
      setInitFailure(null);
      if (result.awaitingRestart) {
        setNeedsRestart(true);
        // As after a save: the settings page still wants fresh status, or its
        // host keeps the failure this retry just cleared.
        if (variant === 'settings') onSaved();
        return;
      }
      if (result.complete && variant === 'setup') {
        // The same full reload the completing save does, for the same reason:
        // the browser's branch model predates the app it is about to open.
        window.location.reload();
        return;
      }
      onSaved();
    } catch (err) {
      if (err instanceof KbInitFailed) {
        setClearedFailure(null);
        setInitFailure(err.kbInit);
      } else setError(err instanceof Error ? err.message : 'Could not retry the initialization.');
    } finally {
      setRetrying(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    await saveNow();
  }

  /**
   * Store the draft. Called by the form, and again by the repository-change
   * confirmation with the decision the admin made — the SAME path, so a
   * confirmed save proves the connection and fills in the branch fields
   * exactly as an ordinary one does.
   */
  async function saveNow(confirmRepositoryChange?: RepositoryChangeChoice) {
    // A save during a sign-in check would clear the draft the check is about.
    if (saving || retrying || oidcTesting) return;
    setSaving(true);
    setError(null);
    setProblems({});
    // The list describes what the LAST completed save left unanswered. A new
    // attempt supersedes it — leaving it up put "Saved what you filled in, but
    // this deployment still needs…" directly above this attempt's "Not saved."
    setStillMissing([]);
    setRepositoryChanged(null);
    try {
      let payload = chosenRepository(draft);
      /** What the host said this time, or null when it could not be asked. */
      let proven: ConnectionTest | null = test;
      let probed = false;
      const prove = async () => {
        probed = true;
        try {
          const { result, derived } = await probeConnection();
          proven = result;
          payload = { ...payload, ...derived };
        } catch {
          // The lookup itself failed — the endpoint is down, the request threw.
          // That is not evidence about the credentials, so nothing is concluded
          // from it and the save carries on: the server has the last word, and
          // a failed lookup is not an error the reader can act on.
          proven = null;
        }
      };

      if (mustProveConnection && !test?.ok) {
        // PROVE THE CONNECTION BEFORE STORING IT. The server's completeness
        // check asks only whether the answers are PRESENT — so a token the
        // host rejects finishes setup just as well as one it accepts, and the
        // gate opens onto an app whose every call fails against a repository
        // it cannot clone. This is the one moment that can tell the two apart.
        await prove();
        // Includes a probe the server REFUSED (a 4xx comes back as a
        // rejection, not a throw) — that is an answer about these values.
        if (proven && !proven.ok) {
          // THE SERVER'S OWN WORDS FIRST. The sentences below say that the
          // save did not happen; only the host knows WHY — "there is no
          // repository at that address", "the host rejected the credentials".
          // Replacing that with a generic sentence is how an admin is left
          // reading "fix the connection" with no idea what is wrong with it.
          const refusal =
            proven.outcome === 'read-only'
              ? 'Not saved. The token can read the repository but cannot write to it — grant it write access and test again.'
              : variant === 'setup'
                ? 'Not saved. Nothing behind this screen works until the repository answers, and it did not — fix the connection above and test it again.'
                : 'Not saved. The repository did not answer with those details — fix the connection above and test it again.';
          setError(proven.error ? `${refusal} The server said: ${proven.error}` : refusal);
          return;
        }
      }

      // Someone who pressed Save without pressing Test has supplied everything
      // they can be expected to know; a branch name is something we can look
      // up, so refusing over it asks a question with a knowable answer. Only
      // when the remote has not already been asked this time round — the probe
      // above fills the same fields from the same answer.
      if (
        !probed &&
        // Only a repository reached by its address is asked this way.
        byAddress &&
        // No address, nothing to look a branch up in.
        !!resolvedIn(payload, 'kbRepoUrl') &&
        (!resolvedIn(payload, 'defaultBranch') || !resolvedIn(payload, 'protectedBranches'))
      ) {
        await prove();
      }
      // An ordinary save is sent exactly as it always was — one argument, and
      // no `confirmRepositoryChange` in the body. Only the save that answers
      // the repository-change confirmation carries the answer.
      const result = confirmRepositoryChange
        ? await saveSettings(payload, confirmRepositoryChange, moveAsked?.openChangeRequests)
        : await saveSettings(payload);
      // A save while a failure stands re-ran the initialization, and it held.
      setClearedFailure(initFailure);
      setInitFailure(null);
      setRestartRequired(result.restartRequired);
      // The confirmation was answered — and the answer went through.
      setRepositoryChange(null);
      setRepositoryChanged(result.repositoryChange ?? null);
      setDraft({});
      if (result.oidcVerification) setLatest(result.oidcVerification);
      // A save can succeed and STILL leave the deployment unusable: a blank
      // field means "leave it alone", not "this is wrong", so the server
      // accepts a batch that answers only some of what it needs. Saying so is
      // the difference between a form that looks broken and one that tells you
      // what is left.
      // An address and a token are owed only by a deployment that reaches
      // its repository by them; the branch model by every one.
      const way = result.repository ? (result.repository.chosen ?? result.repository.mode) : 'token';
      const owed = (way ?? 'token') === 'token' ? REQUIRED_KEYS : BRANCH_MODEL_KEYS;
      const missing = result.settings
        .filter((setting) => owed.includes(setting.key) && !setting.configured)
        .map((setting) => FIELDS[setting.key]?.label ?? setting.key);
      setStillMissing(result.complete || result.awaitingRestart ? [] : missing);
      if (result.awaitingRestart) {
        setNeedsRestart(true);
        // The settings page still wants fresh status — the notice above says
        // what the restart is for; the form should show what was saved.
        if (variant === 'settings') onSaved();
        return;
      }
      if (result.complete && variant === 'setup') {
        // A FULL RELOAD, not just re-rendering the gate. The branch model the
        // browser holds was fetched before any of this existed, and every
        // module that reads it took its value then — so the app behind the
        // gate would build URLs for a branch called nothing. Reloading is the
        // one thing guaranteed to re-fetch it everywhere.
        //
        // SETUP MODE ONLY: on the settings page the app around the form is
        // already running against a fetched branch model, and yanking the
        // whole document out from under an admin who just pressed Save is
        // not a refresh, it is a punishment. Rare branch-model edits there
        // arrive with `restartRequired`, which the notice explains.
        window.location.reload();
        return;
      }
      onSaved();
    } catch (err) {
      if (err instanceof SettingsProblems) {
        showProblems(err.problems);
      } else if (err instanceof RepositoryChangeNeedsConfirmation) {
        // NOT an error: nothing was saved and nothing was destroyed. The
        // draft stays exactly as typed — the confirmed save re-sends it.
        setRepositoryChange({ openChangeRequests: err.openChangeRequests, from: err.from, to: err.to, target: moveTarget });
        setChangeChoice('keep');
      } else if (err instanceof KbInitFailed) {
        // The values ARE stored — only the initialization failed. The form
        // shows what was saved, and the banner says what to fix and retries
        // without asking for any of it again.
        setClearedFailure(null);
        setInitFailure(err.kbInit);
        setDraft({});
        // The confirmation was ANSWERED — the address is stored; it is the
        // initialization that failed, and the banner above owns the retry.
        // Left standing, it would offer Replace for a change that already
        // happened, over a draft this line has just cleared: a second click
        // would re-send the stored address, change nothing, and swallow the
        // "requests closed" outcome for good.
        setRepositoryChange(null);
        setChangeChoice('keep');
        onSaved();
      } else setError(err instanceof Error ? err.message : 'Could not save these settings.');
    } finally {
      setSaving(false);
      // The page scrolls now, and every message lands at the top of it while
      // the button that produced them is at the bottom. Without this, pressing
      // Save on a long form looks like pressing Save did nothing.
      requestAnimationFrame(() => noticeRef.current?.scrollIntoView({ block: 'nearest' }));
    }
  }

  /**
   * Branch names the connection test found on the remote. Offered as
   * suggestions on the branch fields: these have to match the repository
   * EXACTLY, and a typo produces a deployment pointing at a branch nobody has —
   * which is precisely what a form can prevent and an environment variable
   * cannot.
   */
  const remoteBranches = test?.ok ? (test.branches ?? []) : [];

  /**
   * The top-level folders the connection test found, or null when there is
   * nothing to judge the root fields against: no test yet, a failed one, a
   * listing that did not come back — or an EMPTY repository, whose one message
   * already says everything will be set up, and three "will be created" notes
   * beneath it would only repeat that.
   */
  const remoteRootFolders =
    test?.ok && !test.empty && Array.isArray(test.rootFolders) ? test.rootFolders : null;

  /**
   * What the repository holds for one root field, as it would save now. Judged
   * live against the listing — the listing describes the repository, not the
   * field, so correcting the name to the one suggested says "found" at once.
   * Never a problem that blocks the save: an admin may mean to create the
   * folder, or to rename the old one later.
   */
  function renderRootFolderState(key: keyof KbLayout) {
    if (!remoteRootFolders) return null;
    const name = resolved(key) || DEFAULT_KB_LAYOUT[key];
    const state = rootFolderState(name, remoteRootFolders);
    const folder = (value: string) => <code className="font-mono">{value}</code>;
    return (
      <p id={`${key}-repo-state`} className={`mt-1 text-meta ${state.kind === 'variant' ? 'text-wait' : 'text-ok'}`}>
        {state.kind === 'found' && <>{folder(name)} found in the repository.</>}
        {state.kind === 'missing' && (
          <>{folder(name)} is not in the repository yet — it will be created.</>
        )}
        {state.kind === 'variant' && (
          <>
            Not found — the repository has {folder(state.candidate)} (
            {VARIANT_DIFFERENCE[state.difference]}): set
            this field to {folder(state.candidate)} or rename the folder.
          </>
        )}
      </p>
    );
  }


  function renderField(setting: SettingStatus) {
    const copy = FIELDS[setting.key];
    if (!copy) return null;
    const isBranchField = setting.key === 'defaultBranch' || setting.key === 'protectedBranches';
    const isFolderField = isRootFolderKey(setting.key);
    const suggestions = isBranchField
      ? remoteBranches
      : isFolderField
        ? (remoteRootFolders ?? []).filter(isRootFolderSuggestion)
        : [];
    if (copy.toggle) {
      const raw = draft[setting.key] ?? setting.value ?? '';
      const checked = raw === '' ? copy.toggle.on : raw !== 'false';
      return (
        <div key={setting.key}>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={checked}
              onChange={(e) => set(setting.key, e.target.checked ? 'true' : 'false')}
              aria-invalid={problems[setting.key] ? true : undefined}
              aria-describedby={problems[setting.key] ? `${setting.key}-problem` : undefined}
            />
            <span className="text-detail font-medium text-ink">{copy.label}</span>
          </label>
          <p className="mt-1 text-meta text-ink-faint">{copy.help}</p>
          {problems[setting.key] && (
            <p id={`${setting.key}-problem`} role="alert" className="mt-1 text-meta text-danger">
              {problems[setting.key]}
            </p>
          )}
        </div>
      );
    }
    const listId = suggestions.length > 0 ? `${setting.key}-options` : undefined;
    return (
      <div key={setting.key}>
        <label className="block space-y-1.5">
          <span className="text-detail font-medium text-ink">{copy.label}</span>
          <TextField
            type={setting.secret ? 'password' : 'text'}
            autoComplete={setting.secret ? 'new-password' : 'off'}
            placeholder={
              // A configured secret has no value to show, so the field says
              // what leaving it blank means instead.
              setting.secret && setting.configured ? 'Saved. Type to replace' : copy.placeholder
            }
            value={draft[setting.key] ?? (setting.secret ? '' : (setting.value ?? ''))}
            onChange={(e) => set(setting.key, e.target.value)}
            list={listId}
            aria-invalid={problems[setting.key] ? true : undefined}
            aria-describedby={problems[setting.key] ? `${setting.key}-problem` : undefined}
          />
        </label>
        {listId && (
          <datalist id={listId}>
            {suggestions.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        )}
        <p className="mt-1 text-meta text-ink-faint">{copy.help}</p>
        {isRootFolderKey(setting.key) && renderRootFolderState(setting.key)}
        {setting.key === 'kbSyncSecret' && renderSyncPanel()}
        {/* Only AFTER setup: on first run there is nothing yet to lose, so
            the caution would be noise. Once a deployment is live, this field
            is the one whose careless edit strands everything. */}
        {variant === 'settings' && setting.key === 'kbRepoUrl' && (
          <p className="mt-1.5 text-meta text-ink-muted">
            <b className="font-semibold">
              Only change this if the same repository was moved or renamed.
            </b>{' '}
            Pointing it at a different repository does not carry anything over: the knowledge,
            skills and tools stay in the old one, and open change requests will stop working.
          </p>
        )}
        {problems[setting.key] && (
          <p id={`${setting.key}-problem`} role="alert" className="mt-1 text-meta text-danger">
            {problems[setting.key]}
          </p>
        )}
      </div>
    );
  }

  // `h-full`, NOT `min-h-full`. `#root` is `height: 100%; overflow: hidden`, so
  // a MINIMUM height lets this box grow past the viewport and be clipped there
  // — `overflow-y-auto` then scrolls nothing, because nothing bounds the height
  // it would scroll within. Being exactly the height of the root is what makes
  // the overflow this element's own to handle.
  return (
    <div className={variant === 'setup' ? 'h-full overflow-y-auto bg-sunken px-6 py-12' : ''}>
      <div className={variant === 'setup' ? 'mx-auto w-full max-w-2xl' : 'w-full max-w-2xl'}>
        {variant === 'setup' && (
          <>
            <h1 className="text-display font-semibold text-ink">Set up this deployment</h1>
            <p className="mt-2 max-w-[62ch] text-lede text-ink-muted">
              {repository
                ? 'One thing is needed before anyone can use it: somewhere to keep your knowledge, skills and tools. Choose where below; this deployment can keep it for you. Single sign-on is optional and can wait.'
                : 'One thing is needed before anyone can use it: somewhere to keep your knowledge, skills and tools. Connect a repository below, test it, and the rest fills itself in. Single sign-on is optional and can wait.'}
            </p>
          </>
        )}

        <div ref={noticeRef}>
          {/* Back from GitHub, with a secret that was typed before the trip
              and not kept. Said, because an empty field that was full a
              minute ago otherwise reads as something that went wrong. It
              goes as each is entered again. */}
          {toEnterAgain.length > 0 && (
            <Banner tone="wait" role="status" className="mt-6" data-testid="enter-again">
              What you had entered is back, except{' '}
              {toEnterAgain.map((key) => FIELDS[key]?.label ?? key).join(', ')}. For safety, a secret is not kept while
              the browser is away: enter {toEnterAgain.length === 1 ? 'it' : 'them'} again.
            </Banner>
          )}
          {/* Saved, but the knowledge base behind the gate was never set up.
              The cause is the server's classified sentence — what to fix, not
              what git said — and the retry needs nothing re-entered. */}
          {initFailure && (
            <Banner tone="danger" role="alert" className="mt-6" data-testid="kb-init-failure">
              <p className="font-semibold">Saved, but the knowledge base could not be initialized</p>
              <p className="mt-1">{initFailure.cause}</p>
              {draftChanged && (
                <p className="mt-1">
                  The form has unsaved changes — saving them retries the initialization with them.
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void retryInitialization()}
                disabled={retrying || saving || testing || draftChanged}
              >
                {retrying ? 'Initializing…' : 'Retry initialization'}
              </Button>
            </Banner>
          )}

          {/* What the save that moved the deployment actually did. */}
          {repositoryChanged && (
            <Banner tone="ok" role="status" className="mt-6" data-testid="repository-changed">
              <p>
                Saved. This deployment now works on the new repository.
              </p>
              {repositoryChanged.choice === 'close' && repositoryChanged.closedChangeRequests > 0 && (
                <p className="mt-1">
                  {repositoryChanged.closedChangeRequests === 1
                    ? '1 change request was closed as “repository replaced”.'
                    : `${repositoryChanged.closedChangeRequests} change requests were closed as “repository replaced”.`}{' '}
                  Nothing was deleted.
                </p>
              )}
            </Banner>
          )}

          {error && (
            <Banner tone="danger" role="alert" className="mt-6">
              {error}
            </Banner>
          )}

          {/* Saved, and still not usable. Without this the form empties itself
              and comes back looking untouched — indistinguishable from a save
              that silently failed. */}
          {needsRestart && (
            <Banner tone="wait" role="status" className="mt-6">
              Saved. This deployment needs a restart to pick the branch settings up; everything
              else is in place.
            </Banner>
          )}

          {stillMissing.length > 0 && (
            <Banner tone="wait" role="status" className="mt-6">
              Saved what you filled in, but this deployment still needs{' '}
              <b className="font-semibold">{stillMissing.join(', ')}</b> before anyone can use it.
              Test the connection and the version fields fill themselves in.
            </Banner>
          )}
        </div>

        {/* Only when setup is otherwise DONE. While it is not, the banner
            above is already asking for a restart for the same reason, and two
            notices saying "restart" differ only in urgency — which is exactly
            the distinction a reader would miss. */}
        {restartRequired && !needsRestart && (
          <Banner tone="wait" role="status" className="mt-6">
            Saved. One of those settings only takes effect when the server starts, so restart it
            when convenient.
          </Banner>
        )}

        {/* Named so its submit button can sit outside it, below the
            Marketplace section: the button is the last thing on the page, but
            Marketplace is deliberately not part of this form (see below). */}
        <form id="setup-settings-form" onSubmit={submit} className="mt-8 space-y-10">
          {sections.map((section) => {
            const fields = editable.filter(
              (s) =>
                s.section === section.id &&
                // Chosen by its tab, not typed into a field.
                s.key !== 'gitMode' &&
                // Chosen from a list, by the panel of its tab.
                s.key !== 'githubRepository' &&
                // The address, the token and the name beside it belong to the
                // one way that reaches a repository by them.
                (byAddress || !CONNECTION_KEYS.includes(s.key)),
            );
            // The ways of having a repository, each on a tab of its own.
            const repositoryTabs = section.id === 'knowledge-base' ? repository : undefined;
            // A section whose every field comes from the environment has
            // nothing to offer — the locked list at the bottom already names
            // them, and an empty heading would read as something missing.
            if (fields.length === 0) return null;
            // Two ways of signing in, each on a tab of its own.
            const tabbed = section.id === 'sign-in' && signInOption !== undefined;
            const redirectUri = (
              <p className="mt-1.5 text-meta text-ink-faint">
                Redirect URI:{' '}
                <code className="font-mono">{`${window.location.origin}/api/auth/oidc/callback`}</code>
              </p>
            );
            return (
              <Surface
                key={section.id}
                as="section"
                tone="surface"
                radius="lg"
                elevation="card"
                className="p-6 space-y-6"
              >
                <div>
                  <div className="flex items-baseline gap-2.5">
                    <h2 className="text-title font-semibold text-ink">{section.title}</h2>
                    {/* Says outright that a whole section can be skipped. The
                        gate only blocks on the knowledge base and the
                        versions, and someone who does not know that will fill
                        in an identity provider they do not have. */}
                    {section.id === 'sign-in' && (
                      <span className="text-meta text-ink-faint">Optional</span>
                    )}
                  </div>
                  <p className="mt-1 max-w-[60ch] text-detail text-ink-muted">
                    {repositoryTabs
                      ? 'Where everything lives, together in one git repository: knowledge, skills and tools. Choose where that repository is.'
                      : section.blurb}
                  </p>
                  {/* About the deployment's own provider: under the heading
                      when that is all the section holds, inside its tab when
                      the section has two. */}
                  {section.id === 'sign-in' && !tabbed && redirectUri}
                </div>
                {section.id === 'sign-in' && signInOption && (
                  <>
                    <div role="tablist" aria-label="How people sign in" className="flex gap-1 border-b border-line">
                      {(
                        [
                          ['managed', signInOption.label],
                          ['own', signInOption.ownProviderLabel ?? 'Your own provider'],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          id={`sign-in-tab-${id}`}
                          aria-selected={signInTab === id}
                          aria-controls={`sign-in-panel-${id}`}
                          onClick={() => setSignInTab(id)}
                          className={`-mb-px border-b-2 px-3 py-2 text-detail font-medium ${
                            signInTab === id
                              ? 'border-accent text-ink'
                              : 'border-transparent text-ink-muted hover:text-ink'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {signInTab === 'managed' && (
                      <div
                        role="tabpanel"
                        id="sign-in-panel-managed"
                        aria-labelledby="sign-in-tab-managed"
                        onKeyDown={keepEnterFromTheForm}
                      >
                        {/* The distribution's code: a throw in it costs this
                            tab, not the form the repository is entered on. */}
                        <SlotBoundary label="sign-in panel">
                          <signInOption.Panel variant={variant} ownProviderConfigured={ownProviderConfigured} />
                        </SlotBoundary>
                      </div>
                    )}
                  </>
                )}

                {/* The section's own fields: every field it has, in ONE
                    place. With a distribution's tab beside them they are
                    the second tab's panel, there while that tab is open;
                    what was typed stays in the draft either way, so
                    switching tabs loses nothing and saves what was entered. */}
                {(!tabbed || signInTab === 'own') && (
                <SectionFields panel={tabbed ? { group: 'sign-in', id: 'own' } : null}>
                {tabbed && redirectUri}
                {repositoryTabs && (
                  <div role="tablist" aria-label="Where the repository is" className="flex gap-1 border-b border-line">
                    {repositoryTabs.modes.map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        role="tab"
                        id={`repository-tab-${mode}`}
                        aria-selected={gitTab === mode}
                        aria-controls={`repository-panel-${mode}`}
                        // Chosen by the environment, the choice is not the
                        // screen's: the other ways are shown, as what they
                        // are, and cannot be opened.
                        disabled={repositoryTabs.pinned !== undefined && mode !== gitTab}
                        onClick={() => setGitTab(mode)}
                        className={`-mb-px border-b-2 px-3 py-2 text-detail font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                          gitTab === mode
                            ? 'border-accent text-ink'
                            : 'border-transparent text-ink-muted hover:text-ink'
                        }`}
                      >
                        {GIT_MODE_LABEL[mode]}
                      </button>
                    ))}
                  </div>
                )}
                {repositoryTabs?.pinned && (
                  <p className="text-meta text-ink-faint" data-testid="repository-pinned">
                    Set by the <span className="font-mono">{repositoryTabs.pinned}</span> environment variable. Change it
                    there.
                  </p>
                )}
                {/* What the open tab asks: nothing, for a repository the
                    deployment keeps; the address and the token, and the test
                    that proves them, for one reached by them. */}
                <SectionFields panel={repositoryTabs ? { group: 'repository', id: gitTab } : null}>
                {repositoryTabs && movePending && gitTab === chosen && (
                  <Banner tone="wait" role="status" data-testid="move-pending">
                    A restart is pending. This deployment is still working on &ldquo;{movingFrom}&rdquo; and moves
                    here when it is restarted. To stay where it is, open &ldquo;{movingFrom}&rdquo; and save.
                  </Banner>
                )}
                {repositoryTabs && savingMoves && gitTab !== inEffect && (
                  <Banner tone="wait" role="status" data-testid="moves-repository">
                    Saving moves this deployment to another repository, which starts without what the
                    current one holds. Nothing is deleted: the current repository is left as it is, and
                    this deployment&rsquo;s working copies of it are set aside. You are asked to confirm
                    before anything moves.
                  </Banner>
                )}
                {repositoryTabs && savingMoves && gitTab === inEffect && (
                  <Banner tone="wait" role="status" data-testid="move-taken-back">
                    Saving takes the move back: this deployment stays on the repository it is working on.
                  </Banner>
                )}
                {repositoryTabs && gitTab === 'github-app' && (
                  <GitHubRepositoryPanel
                    repository={resolved('githubRepository')}
                    onChoose={(name) => set('githubRepository', name)}
                    problem={problems.githubRepository}
                    disabled={saving}
                    // The browser is about to leave for GitHub, and the page
                    // that comes back is a new one.
                    onLeaving={() => keepDraft(draft, isSecret)}
                  />
                )}
                {repositoryTabs && gitTab === 'managed' && (
                  <div className="space-y-2" data-testid="managed-repository">
                    <p className="max-w-[60ch] text-detail text-ink">
                      This deployment keeps the repository itself. There is nothing to connect and
                      nothing to enter.
                    </p>
                    <p className="max-w-[60ch] text-meta text-ink-muted">
                      Everything is versioned as it is with any repository: every change is a commit,
                      and changes are reviewed as change requests. The repository is stored with this
                      deployment&rsquo;s backups, so backing those up backs it up. You can move to a
                      repository of your own later.
                    </p>
                  </div>
                )}
                {fields
                  .filter(
                    (f) =>
                      !FIELDS[f.key]?.advanced &&
                      !isLayoutKey(f.key) &&
                      (section.id !== 'sign-in' || OIDC_KEYS.includes(f.key)),
                  )
                  .map((f) => renderField(f))}

                {/* Directly under the three answers it proves. */}
                {section.id === 'sign-in' && renderOidcPanel()}
                {section.id === 'sign-in' &&
                  fields
                    .filter((f) => !FIELDS[f.key]?.advanced && !OIDC_KEYS.includes(f.key))
                    .map((f) => renderField(f))}

                {/* Immediately under the two fields it proves, and above the
                    Advanced block it fills in — the middle of the sequence
                    someone actually performs. It used to sit after every
                    section, so the answer to "did I type the token right?"
                    was below the identity-provider questions and, once the
                    page grew, below the fold entirely. */}
                {section.id === 'knowledge-base' && byAddress && (
                  <Surface tone="sunken" radius="md" className="p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void runTest()}
                        // Also while SAVING: a save may be asking the remote
                        // itself, and a second test racing it would overwrite
                        // both the result and the versions derived from it.
                        disabled={testing || saving || retrying}
                      >
                        {testing ? 'Checking…' : 'Test connection'}
                      </Button>
                      <span className="text-meta text-ink-faint">
                        Checks the address and token against the host, looks for the folders below,
                        and fills in the versions.
                      </span>
                    </div>
                    {test && (
                      <p
                        role="status"
                        className={`mt-3 text-detail ${test.ok ? 'text-ok' : 'text-danger'}`}
                      >
                        {test.ok
                          ? test.empty
                            ? 'Connected. The repository is empty; it will be set up for you on first use, and the version fields below are filled in with the standard name.'
                            : `Connected. Found ${test.branches?.length ?? 0} branch${
                                test.branches?.length === 1 ? '' : 'es'
                              }.`
                          : test.error}
                      </p>
                    )}
                  </Surface>
                )}
                </SectionFields>

                {/* The layout: the three root folders, in the main section,
                    directly under the test whose listing they are checked
                    against — the connection fields above it stay next to the
                    button that proves them. */}
                {fields.filter((f) => isLayoutKey(f.key)).map((f) => renderField(f))}

                {/* Everything a normal setup never touches, out of the way but
                    not hidden: a self-hosted git server does need the token
                    username, and a provider with unusual scopes does need
                    those. Closed by default, because leaving them open makes a
                    two-field form look like a seven-field one. */}
                {fields.some((f) => FIELDS[f.key]?.advanced) && (
                  <details
                    // Forced open when something inside it is wrong. The branch
                    // pair lives here and the server validates it as a pair, so
                    // a message about it could otherwise land in a box the
                    // reader has no reason to open — a form that refuses to
                    // save and will not say why.
                    open={fields.some(
                      (f) =>
                        FIELDS[f.key]?.advanced &&
                        (problems[f.key] || stillMissing.includes(FIELDS[f.key]?.label ?? '')),
                    )}
                    className="group rounded-md border border-line bg-sunken px-3.5 py-2.5"
                  >
                    <summary className="cursor-pointer list-none text-detail font-medium text-ink-muted marker:hidden hover:text-ink">
                      Advanced
                      <span className="ml-1.5 text-meta text-ink-faint">
                        (sensible defaults; open only if you need to change one)
                      </span>
                    </summary>
                    <div className="mt-4 space-y-6">
                      {fields.filter((f) => FIELDS[f.key]?.advanced).map((f) => renderField(f))}
                    </div>
                  </details>
                )}

                {/* The sync panel normally hangs off the secret's field. When
                    the secret comes from the environment that field is in the
                    locked list below, not here — but the address, the last
                    update and Update now are about the deployment, not the secret,
                    and an admin with an env-set secret needs them just as much. */}
                {section.id === 'knowledge-base' &&
                  sync &&
                  !fields.some((f) => f.key === 'kbSyncSecret') &&
                  renderSyncPanel()}
                </SectionFields>
                )}
              </Surface>
            );
          })}


          {/* When EVERY knowledge-base setting comes from the environment the
              section above does not render at all, and the sync panel that
              normally lives inside it would vanish with it. The panel is
              about the deployment, not about any one editable field, so it
              gets its own place here in that case. */}
          {sync && editable.every((s) => s.section !== 'knowledge-base') && (
            <Surface as="section" tone="surface" radius="lg" elevation="card" className="p-6">
              <h2 className="text-title font-semibold text-ink">Updates from your git host</h2>
              <p className="mt-1 max-w-[60ch] text-detail text-ink-muted">
                The knowledge-base connection is set by the environment. The hook that brings in
                updates from your git host is still yours to wire up and check on here.
              </p>
              {renderSyncPanel()}
            </Surface>
          )}

          {/* Every sign-in setting from the environment: the section above
              does not render, but whether that configuration works is still
              the admin's to see and to test. */}
          {editable.every((s) => s.section !== 'sign-in') &&
            verification &&
            verification !== 'not-configured' && (
              <Surface as="section" tone="surface" radius="lg" elevation="card" className="p-6 space-y-4">
                <h2 className="text-title font-semibold text-ink">Single sign-on</h2>
                {renderOidcPanel()}
              </Surface>
            )}
        </form>

        {/* Outside the form: nothing in it is saved by "Save and continue".
            On the Deployment page only: the first run asks for the
            repository and for sign-in (see FIRST_RUN_SECTIONS). */}
        {variant === 'settings' && <MarketplaceSection variant={variant} />}

        {/* The submit button lives HERE, after Marketplace, though it belongs
            to the form above — `form=` is what lets those two facts hold at
            once. It is the last thing on the page because a reader should
            meet every section, Marketplace included where it is shown, before
            the control that leaves the screen; when it sat above Marketplace,
            the page looked finished while a section was still below it.

            A rejected connection stops here rather than at the far side of
            it. Saving these answers would finish setup — the server checks
            that they are present, not that they work — and open the app onto
            a repository it cannot reach, which reads as a broken product
            rather than a wrong token. */}
        {/* ASKED WHERE THE DECISION IS MADE, AND ASKED ONCE. The tab is the
            choice, and the tab is a screen above this button: an admin who
            opened another way to read about it, then changed something else
            and saved, would have moved the deployment to an empty
            repository. So the server refuses a save that moves until the
            admin has said yes, and the question is put here, naming what is
            left and what is moved to. Nothing is stored and nothing is set
            aside while it stands; the draft is still on screen, and
            answering re-sends it. */}
        {moveAsked && (
          <Banner tone="wait" role="alert" className="mt-10" data-testid="repository-change-confirm">
            <p className="font-semibold">
              {moveAsked.from && moveAsked.to && moveAsked.from !== moveAsked.to
                ? `Move this deployment from “${GIT_MODE_LABEL[moveAsked.from]}” to “${GIT_MODE_LABEL[moveAsked.to]}”?`
                : 'Move this deployment to another repository?'}
            </p>
            <p className="mt-1">
              The move happens as soon as you confirm, with no restart. Unless the new repository holds the
              same history, every working copy on this server stops being used and is cloned fresh from the
              new repository. Anything saved here that hasn’t reached your git host yet goes out of
              the app with it. Nothing is deleted, but it is only
              recoverable from the
              <code className="mx-1">replaced-working-copies</code>
              folder on the server, by hand.
            </p>
            {moveAsked.openChangeRequests > 0 && (
              <fieldset className="mt-3">
                <legend className="font-semibold">
                  {moveAsked.openChangeRequests === 1
                    ? 'There is 1 open change request.'
                    : `There are ${moveAsked.openChangeRequests} open change requests.`}
                </legend>
                <label className="mt-1 flex items-start gap-2">
                  <input
                    type="radio"
                    name="repository-change-requests"
                    className="mt-1"
                    checked={changeChoice === 'keep'}
                    onChange={() => setChangeChoice('keep')}
                  />
                  <span>Keep them open: the same repository only moved.</span>
                </label>
                <label className="mt-1 flex items-start gap-2">
                  <input
                    type="radio"
                    name="repository-change-requests"
                    className="mt-1"
                    checked={changeChoice === 'close'}
                    onChange={() => setChangeChoice('close')}
                  />
                  <span>
                    Close them as “repository replaced”: this is a different repository and their
                    branches are not in it. Nothing is deleted, and the file locks held on those
                    branches are released.
                  </span>
                </label>
              </fieldset>
            )}
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void saveNow(moveAsked.openChangeRequests > 0 ? changeChoice : 'keep')}
                // The same things that stop a save: a click must never do nothing.
                disabled={saving || testing || retrying || oidcTesting}
              >
                {saving ? 'Moving…' : 'Move the deployment'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRepositoryChange(null)}
                disabled={saving || testing}
              >
                Cancel
              </Button>
            </div>
          </Banner>
        )}
        <div className={`${moveAsked ? 'mt-4' : 'mt-10'} flex flex-wrap items-center justify-end gap-3`}>
          {connectionRejected && (
            // Before the button in the DOM so the reason is read first, and
            // so `justify-end` leaves the button itself at the right edge.
            // Not a live region: the test panel above already announced the
            // host's own words, and the save banner announces a blocked
            // attempt. This is the label for a button that will not move.
            <span id="connection-refusal" className="text-meta text-danger">
              {connectionReadOnly
                ? 'That token can read the repository but cannot write to it. Grant write access and test again.'
                : 'The repository turned that connection down. Fix it above and test again.'}
            </span>
          )}
          <Button
            type="submit"
            form="setup-settings-form"
            variant="primary"
            // While the question stands, its own buttons are the way on.
            disabled={saving || testing || retrying || oidcTesting || connectionRejected || moveAsked !== null}
            // Described by the refusal, so a reader who lands on a button
            // that will not move is told why rather than left guessing.
            aria-describedby={connectionRejected ? 'connection-refusal' : undefined}
          >
            {saving ? 'Saving…' : 'Save and continue'}
          </Button>
        </div>

        {fromEnv.length > 0 && (
          <Surface tone="sunken" radius="md" className="mt-10 p-4">
            <h2 className="text-label font-semibold uppercase text-ink-faint">
              Set by the environment
            </h2>
            <p className="mt-1.5 text-meta text-ink-muted">
              These already have a value from this deployment&apos;s configuration, which takes
              precedence over anything saved here. Change them where they are set.
            </p>
            <ul className="mt-3 space-y-1">
              {fromEnv.map((s) => (
                <li key={s.key} className="font-mono text-meta text-ink-muted">
                  {s.envVar}
                </li>
              ))}
            </ul>
          </Surface>
        )}
      </div>
    </div>
  );
}
