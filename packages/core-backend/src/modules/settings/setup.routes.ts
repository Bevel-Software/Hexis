import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import {
  DeploymentSettingsService,
  SettingsValidationError,
  validateHttpsRemote,
} from './deployment-settings.service.js';
import {
  configureBranchModel,
  isBranchModelConfigured,
  validateBranchModel,
} from '@bevel-software/platform-shared';
import '../auth/auth.middleware.js'; // Express Request augmentation

const execFileAsync = promisify(execFile);

/**
 * First-run setup — the deployment's own configuration, for the things that
 * used to be environment-only.
 *
 * WHY THESE ROUTES ARE AUTHENTICATED BUT NOT KB-DEPENDENT: the whole point is
 * to be reachable on a deployment that has no knowledge base yet. That works
 * because the bootstrap admin (`ADMIN_EMAIL`) is recognised without consulting
 * `roles.yaml` — `AdminAccessService` short-circuits on it before any clone is
 * attempted — so the one person who can finish setup can always sign in, and
 * nobody else is let near it.
 */
export function createSetupRoutes(
  settings: DeploymentSettingsService,
  adminAccess: IAdminAccessService,
  /**
   * The KB startup phase, invoked at its SECOND quiet moment: the save that
   * completes first-time setup. The app is gated shut until exactly then
   * (`isComplete`), so no session can be holding a working clone the phase
   * would race.
   */
  kbStartupRunner: { runAll(): Promise<void> },
): express.Router {
  const router = express.Router();

  /**
   * Whether the last setup-time run of the KB startup phase FAILED. While
   * true the deployment stays GATED: the settings are saved but the KB was
   * never initialized, and reporting setup complete would open the app over
   * an unmaintained (possibly unseeded) knowledge base. Saving the setup
   * form again retries the phase; a server restart retries it at boot; a
   * success clears the flag. Per-process state, like the gate itself.
   */
  let kbInitFailed = false;
  /** The failure's message, surfaced to the ADMIN on the status endpoint. */
  let kbInitError: string | null = null;

  const requireAdmin: express.RequestHandler = async (req, res, next) => {
    if (!(await adminAccess.isAdmin(req.userEmail))) {
      res.status(403).json({ error: 'Admins only' });
      return;
    }
    next();
  };

  /**
   * Whether the deployment is usable, and — for an admin — what is missing.
   *
   * Deliberately readable by ANY signed-in user, because everyone needs the
   * answer: a non-admin who arrives mid-setup gets told the deployment is
   * still being configured instead of a broken file tree. Only the admin
   * branch carries the settings themselves, and no branch ever carries a
   * secret's value.
   */
  router.get('/setup/status', async (req, res) => {
    // A failed setup-time KB initialization keeps setup INCOMPLETE: the
    // frontend gates the app on this answer, and opening it over an
    // uninitialized KB would be worse than keeping the setup screen up.
    const complete = isComplete(settings) && !kbInitFailed;
    if (!(await adminAccess.isAdmin(req.userEmail))) {
      res.json({ complete, isAdmin: false });
      return;
    }
    res.json({
      complete,
      awaitingRestart: awaitingRestart(settings),
      isAdmin: true,
      settings: settings.describe(),
      ...(kbInitFailed ? { kbInitError } : {}),
    });
  });

  /**
   * Save settings. Validated and written as ONE batch — a repository URL
   * stored without the token that reads it is a deployment that fails at its
   * first clone, so a partial write is never better than none.
   */
  router.post('/setup/settings', requireAdmin, async (req, res) => {
    const body = (req.body ?? {}) as { settings?: Record<string, unknown> };
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.settings ?? {})) {
      if (typeof value !== 'string') {
        res.status(400).json({ error: `"${key}" must be a string.` });
        return;
      }
      entries[key] = value;
    }
    try {
      // Completion is a TRANSITION, so it is measured BEFORE the save: the
      // save that flips it false→true — whichever field arrives last — is the
      // one that must run the KB startup phase, regardless of which save
      // configured the branch model.
      const wasComplete = isComplete(settings);
      const { restartRequired } = await settings.save(entries, req.userId ?? null);
      /**
       * Apply the branch model to THIS process, so pressing Save finishes
       * setup instead of asking for a restart.
       *
       * Only when it was not already configured — reconfiguring a live
       * deployment mid-flight would swap the branches out from under sessions
       * that are using them, which is a different and much less welcome
       * feature. Going from "none" to "some" has nobody to disturb: the app is
       * gated shut until exactly this moment.
       *
       * The services that need it read it when they use it rather than
       * capturing it at construction, which is what makes applying it here
       * enough.
       */
      if (!isBranchModelConfigured()) {
        const model = {
          defaultBranch: settings.resolve('defaultBranch'),
          protectedBranches: settings.resolve('protectedBranches'),
        };
        if (!validateBranchModel(model)) configureBranchModel(model);
      }
      /**
       * The save that COMPLETES setup is the KB startup phase's SECOND quiet
       * moment (the other is boot): the app was gated shut until this very
       * response, so the trees are provably quiet. Run the phase now —
       * seeding the remote, scaffolding and migrating every branch — so the
       * first workspace request that follows finds a maintained KB.
       *
       * Runs on the false→true completion transition — including when the
       * branch model was configured by an EARLIER save and the repository
       * URL arrives on a later one — and again on any save while a previous
       * setup-time run stands failed (`kbInitFailed`), so saving the form is
       * the retry. Never on a re-save of a complete, healthy setup: with the
       * gate open, sessions may be live and that is no longer a quiet moment.
       */
      if ((!wasComplete || kbInitFailed) && isComplete(settings)) {
        try {
          await kbStartupRunner.runAll();
          kbInitFailed = false;
          kbInitError = null;
        } catch (initErr) {
          // The settings ARE saved — only the KB initialization failed. The
          // deployment stays gated (see the status endpoint) until a retry
          // succeeds. Logged in full, returned actionable.
          const msg = initErr instanceof Error ? initErr.message : String(initErr);
          console.error('[setup] KB initialization failed after setup completed:', msg);
          kbInitFailed = true;
          kbInitError = msg;
          res.status(500).json({
            error:
              'Settings saved, but the knowledge base could not be initialized. ' +
              'Saving the setup form again retries; restarting the server retries too.',
          });
          return;
        }
      }
      res.json({
        ok: true,
        restartRequired,
        complete: isComplete(settings) && !kbInitFailed,
        awaitingRestart: awaitingRestart(settings),
        settings: settings.describe(),
      });
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        res.status(400).json({ error: 'Some settings need fixing.', problems: err.problems });
        return;
      }
      // Logged in full, returned generic: a driver message here would hand back
      // the schema or the connection string.
      console.error('[setup] save failed:', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'Could not save these settings.' });
    }
  });

  /**
   * Try the credentials against the real remote, BEFORE anything is saved.
   *
   * This is the reason the screen is worth more than the environment variables
   * it replaces. `ls-remote` is the cheapest operation that proves all three
   * values at once — the URL resolves, the token authenticates, and the
   * username is the one this host expects — and it answers in a second instead
   * of surfacing as a failed clone at some later, unrelated moment.
   *
   * Values are taken from the request when supplied so an admin can test what
   * they typed rather than what is stored, and fall back to what is in effect
   * (which is how "test the token I saved last week" works).
   */
  router.post('/setup/test-connection', requireAdmin, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const supplied = (key: string): string | null => {
      const value = body[key];
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };
    const url = supplied('kbRepoUrl') ?? settings.resolve('kbRepoUrl');
    // Unlike the token, the username is not a secret and carries a default —
    // it is which name the host expects beside the token, not a credential.
    const username =
      supplied('gitUsername') ?? (settings.resolve('gitUsername') || 'x-access-token');

    if (!url) {
      res.status(400).json({ ok: false, error: 'Enter the repository URL first.' });
      return;
    }

    /**
     * THE CONFIGURED TOKEN ONLY EVER GOES TO THE CONFIGURED REPOSITORY.
     *
     * The stored token is deliberately unreadable — `describe()` omits it, so
     * an admin can replace it but never see it. Falling back to it for whatever
     * URL the request names would hand that value straight back: point the test
     * at a host you control, read it out of the request. Admin-gated, but the
     * whole point of not returning it is that being an admin is not the same as
     * being allowed to hold it.
     *
     * So a request that names a DIFFERENT repository has to bring its own
     * credential. Testing what is already configured — the "does the token I
     * saved last week still work?" case — is unaffected.
     */
    const suppliedToken = supplied('gitToken');
    const testingConfiguredRepo = url === settings.resolve('kbRepoUrl');
    if (!suppliedToken && !testingConfiguredRepo) {
      res.status(400).json({
        ok: false,
        error: 'Enter the access token for that repository — the saved one is only used with the repository it was saved for.',
      });
      return;
    }
    const token = suppliedToken ?? (testingConfiguredRepo ? settings.resolve('gitToken') : '');
    // The SAME rule the setting is validated by, applied before the value ever
    // reaches git. Without it this endpoint is argument injection: a value
    // beginning `--upload-pack=` makes git run a command of the caller's
    // choosing, and `ext::sh -c …` is a transport whose entire purpose is to
    // execute one. Both are admin-only, but "admin" is not "may run arbitrary
    // commands as the server process".
    const urlProblem = validateHttpsRemote(url);
    if (urlProblem) {
      res.status(400).json({ ok: false, error: urlProblem });
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(username)) {
      // Interpolated into the credential-helper snippet below.
      res.status(400).json({ ok: false, error: 'The username contains unsupported characters.' });
      return;
    }

    try {
      // The helper reads the token from the environment at call time, so it
      // never appears in argv (and so never in a process listing or a crash
      // dump). Same shape the real clone uses.
      const args = ['-c', 'credential.helper=', ...(token
        ? ['-c', `credential.helper=!f() { echo "username=${username}"; echo "password=$BEVEL_TEST_TOKEN"; }; f`]
        : []),
        // `--end-of-options` on top of the validation above: belt and braces,
        // so nothing that arrives here can ever be read as a flag.
        'ls-remote', '--heads', '--end-of-options', url];
      const { stdout } = await execFileAsync('git', args, {
        timeout: 20_000,
        env: {
          ...process.env,
          BEVEL_TEST_TOKEN: token,
          // Never let git stop for a prompt: without this a bad credential
          // hangs the request until the timeout instead of failing.
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
        },
      });
      const lines = stdout.split('\n');
      // `<sha>\trefs/heads/<name>` — tag refs and the bare HEAD row are not
      // branches, so they are filtered rather than sliced blindly.
      const branches = lines
        .filter((line) => !line.startsWith('ref:'))
        .map((line) => line.split('\t')[1]?.trim())
        .filter((ref): ref is string => !!ref && ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length));
      // `ref: refs/heads/<name>\tHEAD` — what the remote calls its own trunk.
      const defaultBranch =
        lines
          .find((line) => line.startsWith('ref:') && line.trimEnd().endsWith('HEAD'))
          ?.slice('ref: refs/heads/'.length)
          .split('\t')[0]
          ?.trim() || null;
      res.json({
        ok: true,
        // An EMPTY repository is a success, not a failure — seeding one is a
        // supported path, and saying "no branches yet" beats an error that
        // reads like the credentials are wrong.
        empty: branches.length === 0,
        branches,
        defaultBranch,
      });
    } catch (err) {
      res.status(200).json({ ok: false, error: explainGitFailure(err, token) });
    }
  });

  return router;
}

/**
 * Whether the STORED configuration answers everything the deployment needs.
 *
 * The KB needs a URL and a token — the username and the directory name both
 * have working defaults, so neither can block a start. The branch model has no
 * default ON PURPOSE: guessing `main` would silently point a deployment at the
 * wrong branch and let the protected-branch guards apply to nothing, which is
 * worse than asking.
 *
 * SSO is deliberately absent. It is configuration, not a prerequisite — a
 * deployment signs in perfectly well without it, and gating on it would lock
 * an admin out of the screen where they would set it up.
 */
export function settingsAnswered(settings: DeploymentSettingsService): boolean {
  const kb = Boolean(settings.resolve('kbRepoUrl') && settings.resolve('gitToken'));
  const branches =
    validateBranchModel({
      defaultBranch: settings.resolve('defaultBranch'),
      protectedBranches: settings.resolve('protectedBranches'),
    }) === null;
  return kb && branches;
}

/**
 * Whether THIS PROCESS can actually serve — which is not the same question,
 * and conflating them opened the gate onto a broken app.
 *
 * The branch model is applied once, during boot: services take `DEFAULT_BRANCH`
 * at construction and the browser is served it before it renders. Saving it
 * therefore answers the question without changing the answer this process
 * holds — so a deployment configured through the setup screen reported itself
 * complete while every workspace call still failed with
 * `Invalid branch name ""`.
 *
 * Requiring the model to be IN EFFECT keeps the gate shut until the restart
 * that puts it there. {@link awaitingRestart} is what tells the screen to ask
 * for one rather than claim a field is missing.
 */
export function isComplete(settings: DeploymentSettingsService): boolean {
  return settingsAnswered(settings) && isBranchModelConfigured();
}

/** Answered, but not yet in effect: everything is stored, the process is stale. */
export function awaitingRestart(settings: DeploymentSettingsService): boolean {
  return settingsAnswered(settings) && !isBranchModelConfigured();
}

/**
 * Turn git's stderr into something an admin can act on. Deliberately narrow:
 * the raw text is echoed only when it matches nothing known, and the token is
 * scrubbed from it first — `ls-remote` failures have been known to quote the
 * credential back.
 */
function explainGitFailure(err: unknown, token: string): string {
  const raw = err instanceof Error ? `${err.message}` : String(err);
  const text = token ? raw.replaceAll(token, '***') : raw;
  if (/timed out|ETIMEDOUT/i.test(text)) {
    return 'The host did not answer in time. Check the URL, and that this server can reach it.';
  }
  if (/Authentication failed|could not read Username|invalid credentials|403/i.test(text)) {
    return 'The host rejected those credentials. Check the token, and that the username matches the host (GitHub x-access-token, GitLab oauth2, Bitbucket x-token-auth).';
  }
  if (/not found|repository .* does not exist|404/i.test(text)) {
    return 'No repository at that URL — or the token cannot see it.';
  }
  if (/could not resolve host|unable to access|SSL|certificate/i.test(text)) {
    return 'Could not reach that host from this server. Check the URL and any network egress rules.';
  }
  return text.split('\n').slice(0, 3).join(' ').slice(0, 400);
}
