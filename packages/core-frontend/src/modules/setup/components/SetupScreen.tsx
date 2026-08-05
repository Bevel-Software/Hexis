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
};

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

  return (
    <div className="min-h-full overflow-y-auto bg-sunken px-6 py-12">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-display font-semibold text-ink">Connect your knowledge base</h1>
        <p className="mt-2 max-w-[60ch] text-lede text-ink-muted">
          This deployment needs a git repository to keep your knowledge base in. Point it at one and
          everything else follows — the repository can be empty, and will be set up for you.
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

        <form onSubmit={submit} className="mt-8 space-y-6">
          {editable.map((setting) => {
            const copy = FIELDS[setting.key];
            if (!copy) return null;
            return (
              <div key={setting.key}>
                <label className="block space-y-1.5">
                  <span className="text-detail font-medium text-ink">{copy.label}</span>
                  <TextField
                    type={setting.secret ? 'password' : 'text'}
                    autoComplete={setting.secret ? 'new-password' : 'off'}
                    placeholder={
                      // A configured secret has no value to show, so the field
                      // says what leaving it blank means instead.
                      setting.secret && setting.configured
                        ? 'Saved — type to replace'
                        : copy.placeholder
                    }
                    value={draft[setting.key] ?? (setting.secret ? '' : (setting.value ?? ''))}
                    onChange={(e) => set(setting.key, e.target.value)}
                    aria-invalid={problems[setting.key] ? true : undefined}
                    aria-describedby={problems[setting.key] ? `${setting.key}-problem` : undefined}
                  />
                </label>
                <p className="mt-1 text-meta text-ink-faint">{copy.help}</p>
                {problems[setting.key] && (
                  <p id={`${setting.key}-problem`} role="alert" className="mt-1 text-meta text-danger">
                    {problems[setting.key]}
                  </p>
                )}
              </div>
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
