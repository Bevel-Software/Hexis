import { useState, type FormEvent } from 'react';
import { Banner, Button, Surface, TextField } from '../../../shared/components';
import {
  saveSettings,
  testConnection,
  SettingsProblems,
  type ConnectionTest,
  type SettingStatus,
} from '../services/setup.api';

/** Copy for each setting: what it is, in the words of someone who has to fill it in. */
const FIELDS: Record<string, { label: string; help: string; placeholder?: string }> = {
  kbRepoUrl: {
    label: 'Repository URL',
    help: 'The git repository that stores your knowledge base. Any host works — GitHub, GitLab, Bitbucket, Azure DevOps, or your own.',
    placeholder: 'https://github.com/acme/knowledge-base.git',
  },
  gitToken: {
    label: 'Access token',
    help: 'A token that can read and write that repository. Stored encrypted, and never shown again once saved.',
    placeholder: 'ghp_…',
  },
  gitUsername: {
    label: 'Token username',
    help: 'Which username the host expects alongside the token. GitHub uses x-access-token, GitLab oauth2, Bitbucket x-token-auth; Azure DevOps accepts anything.',
    placeholder: 'x-access-token',
  },
  kbDirName: {
    label: 'Folder name',
    help: 'What the knowledge base is called inside each workspace. Cosmetic — leave it alone unless you have a reason.',
    placeholder: 'knowledge-base',
  },
  defaultBranch: {
    label: 'Default branch',
    help: 'Where people land, and where change requests go by default. It must also appear in the protected list below.',
    placeholder: 'main',
  },
  protectedBranches: {
    label: 'Protected branches',
    help: 'Comma-separated. These cannot be written to directly — changes reach them by approval. Branches that do not exist yet are created for you.',
    placeholder: 'main',
  },
  oidcIssuerUrl: {
    label: 'Issuer URL',
    help: 'Your identity provider. Its /.well-known/openid-configuration is read when someone first signs in.',
    placeholder: 'https://login.microsoftonline.com/<tenant>/v2.0',
  },
  oidcClientId: { label: 'Client ID', help: 'From the application you registered with the provider.' },
  oidcClientSecret: {
    label: 'Client secret',
    help: 'Stored encrypted, and never shown again once saved.',
  },
  oidcScopes: {
    label: 'Scopes',
    help: 'Leave blank unless your provider needs more.',
    placeholder: 'openid profile email',
  },
  oidcProviderLabel: {
    label: 'Button label',
    help: 'What the sign-in button says.',
    placeholder: 'Single sign-on',
  },
  allowedEmailDomains: {
    label: 'Allowed email domains',
    help: 'Comma-separated. Single sign-on creates an account the first time someone signs in, so against a provider that is not limited to your organisation this list is what stops anyone signing themselves up. Blank allows any address.',
    placeholder: 'example.com',
  },
};

/** The blocks, in the order they are worked through. */
const SECTIONS: { id: SettingStatus['section']; title: string; blurb: string }[] = [
  {
    id: 'knowledge-base',
    title: 'Knowledge base',
    blurb:
      'The git repository this deployment keeps its knowledge base in. It can be empty — it will be set up for you.',
  },
  {
    id: 'branches',
    title: 'Branches',
    blurb:
      'Which branches this deployment treats as the shared record. Both are read when the server starts, so changing them later takes a restart.',
  },
  {
    id: 'sign-in',
    title: 'Single sign-on',
    blurb:
      'Optional — the deployment works without it. Register this address with your provider as the redirect URI, then fill in the application it belongs to.',
  },
];

interface Props {
  settings: SettingStatus[];
  /** Re-read the status after a save, so the gate can let the app through. */
  onSaved(): void;
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
export function SetupScreen({ settings, onSaved }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  const editable = settings.filter((s) => s.source !== 'env');
  const fromEnv = settings.filter((s) => s.source === 'env');

  function set(key: string, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    // The message described the old value; keeping it beside a new one would
    // be a complaint about something the reader already fixed.
    setProblems((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setTest(null);
  }

  async function runTest() {
    setTesting(true);
    setError(null);
    try {
      setTest(await testConnection(draft));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not test the connection.');
    } finally {
      setTesting(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setProblems({});
    try {
      const result = await saveSettings(draft);
      setRestartRequired(result.restartRequired);
      setDraft({});
      onSaved();
    } catch (err) {
      if (err instanceof SettingsProblems) setProblems(err.problems);
      else setError(err instanceof Error ? err.message : 'Could not save these settings.');
    } finally {
      setSaving(false);
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

  function renderField(setting: SettingStatus) {
    const copy = FIELDS[setting.key];
    if (!copy) return null;
    const isBranchField = setting.section === 'branches';
    const listId = isBranchField && remoteBranches.length > 0 ? `${setting.key}-options` : undefined;
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
              setting.secret && setting.configured ? 'Saved — type to replace' : copy.placeholder
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
            {remoteBranches.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        )}
        <p className="mt-1 text-meta text-ink-faint">{copy.help}</p>
        {problems[setting.key] && (
          <p id={`${setting.key}-problem`} role="alert" className="mt-1 text-meta text-danger">
            {problems[setting.key]}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-y-auto bg-sunken px-6 py-12">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-display font-semibold text-ink">Set up this deployment</h1>
        <p className="mt-2 max-w-[60ch] text-lede text-ink-muted">
          Two things are needed before anyone can use it: a git repository to keep the knowledge
          base in, and which branches count as the shared record. Single sign-on is optional and can
          wait.
        </p>

        {error && (
          <Banner tone="danger" role="alert" className="mt-6">
            {error}
          </Banner>
        )}

        {restartRequired && (
          <Banner tone="wait" role="status" className="mt-6">
            Saved. One of those settings only takes effect when the server starts, so restart it
            when convenient.
          </Banner>
        )}

        <form onSubmit={submit} className="mt-8 space-y-10">
          {SECTIONS.map((section) => {
            const fields = editable.filter((s) => s.section === section.id);
            // A section whose every field comes from the environment has
            // nothing to offer — the locked list at the bottom already names
            // them, and an empty heading would read as something missing.
            if (fields.length === 0) return null;
            return (
              <section key={section.id} className="space-y-6">
                <div>
                  <h2 className="text-title font-semibold text-ink">{section.title}</h2>
                  <p className="mt-1 max-w-[60ch] text-detail text-ink-muted">{section.blurb}</p>
                  {section.id === 'sign-in' && (
                    <p className="mt-1.5 text-meta text-ink-faint">
                      Redirect URI:{' '}
                      <code className="font-mono">{`${window.location.origin}/api/auth/oidc/callback`}</code>
                    </p>
                  )}
                </div>
                {fields.map((setting) => renderField(setting))}
              </section>
            );
          })}

          {/* The point of the screen: prove the answer before committing to it. */}
          <Surface tone="surface" radius="md" className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={() => void runTest()} disabled={testing}>
                {testing ? 'Checking…' : 'Test connection'}
              </Button>
              <span className="text-meta text-ink-faint">
                Asks the host whether the URL, token and username work together.
              </span>
            </div>
            {test && (
              <p
                role="status"
                className={`mt-3 text-detail ${test.ok ? 'text-ok' : 'text-danger'}`}
              >
                {test.ok
                  ? test.empty
                    ? 'Connected. The repository is empty — it will be set up for you on first use.'
                    : `Connected. Found ${test.branches?.length ?? 0} branch${
                        test.branches?.length === 1 ? '' : 'es'
                      }.`
                  : test.error}
              </p>
            )}
          </Surface>

          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save and continue'}
            </Button>
          </div>
        </form>

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
