import express from 'express';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import { logger } from '../../shared/logging.js';

const log = logger('setup');
import {
  DeploymentSettingsService,
  SettingsValidationError,
  validateHttpsRemote,
  type OidcCredentials,
} from './deployment-settings.service.js';
import {
  checkOidcConfiguration,
  checkOidcIssuer,
  normalizeIssuerUrl,
  type IssuerCheck,
  type OidcCheck,
  type OidcConfiguration,
} from './oidc-check.js';
import {
  checkRepositoryConnection,
  type ConnectionCheck,
  type RepositoryConnection,
} from './connection-check.js';
import {
  configureBranchModel,
  configureKbLayout,
  isBranchModelConfigured,
  isDefaultKbLayout,
  validateBranchModel,
  validateKbLayout,
} from '@bevel-software/platform-shared';
import { failureOf, type GitFailure } from '../../shared/git-failure.js';
import { redactSecret, urlQuerySecrets } from '../../shared/redact-secret.js';
import { listRootFolders, pickListingBranch } from './git-root-folders.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

/** Which name a host expects beside the token when none is configured. */
const DEFAULT_GIT_USERNAME = 'x-access-token';

/** The one rule, in the one wording, for a stored token and a repository it was not saved for. */
const TOKEN_FOR_THAT_REPOSITORY =
  'Enter the access token for that repository — the saved one is only used with the repository it was saved for.';

/** The same rule for the application secret and a provider it was not saved for. */
const SECRET_FOR_THAT_PROVIDER =
  'Enter the application secret for that provider — the saved one is only sent to the provider it was saved for.';

/** The three renameable roots, as setting keys. */
const LAYOUT_KEYS: readonly string[] = ['knowledgeBaseDir', 'skillsDir', 'pluginsDir'];
/** The branch model, as setting keys. */
const BRANCH_KEYS: readonly string[] = ['defaultBranch', 'protectedBranches'];

/**
 * The slice of a sync record the status endpoint publishes. Declared here
 * rather than imported from `kb-sync` so this module stays free of that one;
 * the composition root hands in something that satisfies it.
 */
export interface LastSyncStatus {
  at: number;
  by: string;
  status: 'synced' | 'partial';
  results: Array<{ branch: string; outcome: string; error?: string }>;
}

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
  kbStartupRunner: {
    runAll(): Promise<void>;
    /**
     * Why the runner's most recent run failed, if it did — including a BOOT
     * run that survived an unreachable remote. Optional so a minimal mount
     * (tests, a distribution's own runner) reads as never having failed.
     */
    lastFailure?(): string | null;
    /** That failure classified, for the setup screen; absent, the message is read instead. */
    lastFailureKind?(): GitFailure | null;
  },
  /**
   * The remote-sync facts the Deployment page shows beside the sync secret:
   * the address a webhook or pipeline must call, and what the last call did.
   * Optional so a minimal mount (tests, a distribution without the module)
   * simply omits them from the status.
   */
  sync?: {
    /** `<PUBLIC_BACKEND_URL>/api/sync` — the reader appends `/<branch>`. */
    url: string;
    lastSync(): LastSyncStatus | null;
  },
  /**
   * The read+write connection check. Injected so route tests can answer for
   * the remote; production passes the real one bound to the deployment's git
   * runner (`repositoryConnectionCheck`), and the default is the same check on
   * a runner with default settings.
   */
  checkConnection: (connection: RepositoryConnection) => Promise<ConnectionCheck> = checkRepositoryConnection,
  /** The root-folder listing Test connection reports. Injected for the same reason. */
  listFolders: typeof listRootFolders = listRootFolders,
  /**
   * `<PUBLIC_BACKEND_URL>/api/auth/oidc/callback` — the redirect URI the
   * single sign-on check sends, as the real callback does.
   */
  oidcRedirectUri = '',
  /** The single sign-on check. Injected so route tests can answer for the provider. */
  checkOidc: (config: OidcConfiguration) => Promise<OidcCheck> = checkOidcConfiguration,
  /** The issuer-only half, for a test with no application id or secret yet. */
  checkIssuer: (issuerUrl: string) => Promise<IssuerCheck> = (url) => checkOidcIssuer(url),
): express.Router {
  const router = express.Router();

  /**
   * Why the last setup-time run of the KB startup phase FAILED, or null. While
   * set the deployment stays GATED: the settings are saved but the KB was
   * never initialized, and reporting setup complete would open the app over
   * an unmaintained (possibly unseeded) knowledge base. Any save — including
   * an empty one, which is what "Retry initialization" sends — retries the
   * phase; a server restart retries it at boot; a success clears it.
   * Per-process state, like the gate itself.
   *
   * Classified, never raw: the admin gets a kind and a remediation sentence,
   * and what git actually said stays in the server log.
   */
  let kbInit: GitFailure | null = null;
  /**
   * The setup-time run currently executing, if any. Its jobs: (a) keeping the
   * status gate SHUT while a run executes (the settings read complete the
   * moment they save, but the phase is still mutating branch trees — no
   * workspace request may start yet), and (b) defense in depth via the `??=`
   * at the run site, should a second invoker ever appear. It is NOT what
   * serializes saves — the `saveTurn` chain below runs handlers strictly one
   * at a time, phase included, so no second run can start while one executes.
   */
  let kbInitInFlight: Promise<void> | null = null;
  /**
   * Whether the folder names in effect were put there by a setup-time save
   * rather than by boot. While that run stands failed the app is still gated
   * shut, so a retrying save may apply names the admin corrected in between.
   */
  let layoutAppliedBySetup = false;
  /**
   * A failure the RUNNER itself is standing on — a boot that survived an
   * unreachable remote. Read live, because the runner's own background retry
   * clears it without any save passing through here.
   */
  const bootFailure = () => kbStartupRunner.lastFailure?.() ?? null;
  /** The boot failure in the setup screen's terms: the runner's own reading, else one read from its message. */
  const bootFailureKind = (): GitFailure | null => {
    const message = bootFailure();
    if (message === null) return null;
    return kbStartupRunner.lastFailureKind?.() ?? failureOf(message);
  };
  /** The app-gate answer: settings complete AND the KB phase settled clean, whoever ran it. */
  const kbReady = () =>
    isComplete(settings) && kbInit === null && kbInitInFlight === null && bootFailure() === null;

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
    // A failed OR still-running setup-time KB initialization keeps setup
    // INCOMPLETE: the frontend gates the app on this answer, and opening it
    // over an uninitialized (or mid-mutation) KB would be worse than keeping
    // the setup screen up.
    //
    // `kbReady()` is read fresh AFTER the admin check, immediately before
    // building each response: the check awaits, a completion save can start
    // the phase during that await, and a snapshot taken before it would
    // resurrect a pre-phase `true` — opening the gate mid-mutation.
    if (!(await adminAccess.isAdmin(req.userEmail))) {
      res.json({ complete: kbReady(), isAdmin: false });
      return;
    }
    res.json({
      complete: kbReady(),
      awaitingRestart: awaitingRestart(settings),
      isAdmin: true,
      settings: settings.describe(),
      oidcVerification: await settings.oidcVerification(),
      ...(kbInit ? { kbInit } : bootFailure() !== null ? { kbInit: bootFailureKind() } : {}),
      ...(sync ? { sync: { url: sync.url, last: sync.lastSync() } } : {}),
    });
  });

  /**
   * Setup saves run strictly ONE AT A TIME, phase included: `settings.save`
   * updates the live cache write by write, and the completing save runs the
   * KB startup phase, which reads its configuration through live getters —
   * a save interleaving with either would hand half-updated state to the
   * other. A plain promise chain is enough: saves are a setup-screen rarity,
   * not a hot path, and a save arriving mid-run simply waits the previous
   * save (and its phase) out before proceeding.
   */
  let saveTurn: Promise<unknown> = Promise.resolve();

  /**
   * Save settings. Validated and written as ONE batch — a repository URL
   * stored without the token that reads it is a deployment that fails at its
   * first clone, so a partial write is never better than none.
   */
  router.post('/setup/settings', requireAdmin, async (req, res) => {
    const turn = saveTurn.then(() => handleSave(req, res));
    saveTurn = turn.catch(() => {});
    await turn;
  });

  async function handleSave(req: express.Request, res: express.Response): Promise<void> {
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
      if (!(await connectionHoldsFor(entries, wasComplete, res))) return;
      const oidc = await signInHoldsFor(entries, res);
      if (!oidc) return;
      // Recorded BEFORE the save: the record is keyed by the values it is
      // about, so until the save puts them in effect it speaks for nothing —
      // while a record written after a committed save could fail and leave
      // those values unverified with no way back (the retry changes nothing,
      // so it is not probed again).
      if (oidc.record) {
        await settings.recordOidcVerification(oidc.record.state, oidc.record.credentials);
      }
      const { restartRequired, restartKeys } = await settings.save(entries, req.userId ?? null);
      /** Whether this save put the stored folder names into the running process. */
      let layoutApplied = false;
      /** Whether this save put the stored branch model into the running process. */
      let branchModelApplied = false;
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
        if (!validateBranchModel(model)) {
          configureBranchModel(model);
          branchModelApplied = true;
        }
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
       * setup-time run stands failed (`kbInit`), so a save is the retry. Never
       * on a re-save of a complete, healthy setup: with the gate open,
       * sessions may be live and that is no longer a quiet moment.
       */
      if ((!wasComplete || kbInit !== null || bootFailure() !== null) && isComplete(settings)) {
        /**
         * The folder names, applied BEFORE the phase for the same reason as
         * the branch model above: they are otherwise applied once at boot, so
         * the phase would scaffold `Skills/` beside the `skills/` the admin
         * just named, and the app would read the defaults until a restart.
         * Only while the process still holds the defaults — a layout already
         * in effect from the environment or the boot is left alone — or holds
         * the names an earlier setup save applied before a run that failed:
         * the gate never opened, so the retry initializes what is saved now.
         */
        if (isDefaultKbLayout() || (kbInit !== null && layoutAppliedBySetup)) {
          const layout = settings.resolveKbLayout();
          if (!validateKbLayout(layout)) {
            configureKbLayout(layout);
            layoutApplied = true;
            layoutAppliedBySetup = true;
          }
        }
        try {
          // One run at a time. The save chain already serializes handlers
          // whole, so no second run can start while one executes; the `??=`
          // is defense in depth should another invoker ever appear.
          kbInitInFlight ??= kbStartupRunner.runAll();
          await kbInitInFlight;
          // Under KB_SAFE_BOOT a run that abandoned the phase still resolves
          // and opens the gate DELIBERATELY — booting unmaintained so the
          // operator can get in and fix things is exactly what the
          // break-glass is for.
          kbInit = null;
        } catch (initErr) {
          // The settings ARE saved — only the KB initialization failed. The
          // deployment stays gated (see the status endpoint) until a retry
          // succeeds. Logged in full (scrubbed of the token in effect, which
          // may be the one this very save stored), returned classified — by
          // the classification the runner's failure carries, read before any
          // scrub rewrote git's words (`failureOf`).
          const raw = initErr instanceof Error ? initErr.message : String(initErr);
          const msg = redactSecret(raw, [
            settings.resolve('gitToken'),
            ...urlQuerySecrets(settings.resolve('kbRepoUrl')),
          ]);
          log.error(`KB initialization failed after setup completed: ${msg}`);
          kbInit = failureOf(initErr);
          res.status(500).json({
            error: 'Settings saved, but the knowledge base could not be initialized.',
            kbInit,
          });
          return;
        } finally {
          kbInitInFlight = null;
        }
      }
      res.json({
        ok: true,
        // Folder names and a branch model this save just applied are in
        // effect; a restart is owed only for whatever else changed.
        restartRequired:
          layoutApplied || branchModelApplied
            ? restartKeys.some(
                (key) =>
                  !(layoutApplied && LAYOUT_KEYS.includes(key)) &&
                  !(branchModelApplied && BRANCH_KEYS.includes(key)),
              )
            : restartRequired,
        complete: kbReady(),
        awaitingRestart: awaitingRestart(settings),
        settings: settings.describe(),
        oidcVerification: await settings.oidcVerification(),
      });
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        res.status(400).json({ error: 'Some settings need fixing.', problems: err.problems });
        return;
      }
      // Logged in full, returned generic: a driver message here would hand back
      // the schema or the connection string.
      log.error('save failed:', { err });
      res.status(500).json({ error: 'Could not save these settings.' });
    }
  }

  /**
   * A SAVED CONNECTION IS ONE THE HOST HAS ACCEPTED FOR READING AND WRITING.
   *
   * The completeness check asks only whether the answers are present, so
   * without this a token the host rejects — or one that can read but not
   * push — finishes setup as well as a working one, and the first news of it
   * is every save anyone makes failing. The browser proves the connection too,
   * but a browser is not the only client, and it is not the last word.
   *
   * Checked on the values the save WOULD put in effect, and only when the save
   * matters to the connection: it changes the address, the token or the
   * username, or it completes first-run setup. Anything else — single sign-on,
   * say — is never probed, so an admin is not held hostage to a repository
   * that is down while they edit something unrelated.
   *
   * Answers the refusal itself (400, per-field problems) and returns false;
   * true means the save may go ahead. Validation problems in `entries` throw
   * {@link SettingsValidationError} before any probe, exactly as the save would.
   */
  async function connectionHoldsFor(
    entries: Record<string, string>,
    wasComplete: boolean,
    res: express.Response,
  ): Promise<boolean> {
    const after = settings.resolveAfter(entries);
    const now: RepositoryConnection = {
      url: settings.resolve('kbRepoUrl'),
      token: settings.resolve('gitToken'),
      username: settings.resolve('gitUsername') || DEFAULT_GIT_USERNAME,
    };
    const next: RepositoryConnection = {
      url: after('kbRepoUrl'),
      token: after('gitToken'),
      username: after('gitUsername') || DEFAULT_GIT_USERNAME,
    };
    const refuse = (problems: Record<string, string>) => {
      res.status(400).json({ error: Object.values(problems)[0], problems });
      return false;
    };

    // THE CONFIGURED TOKEN ONLY EVER GOES TO THE CONFIGURED REPOSITORY — the
    // same rule the connection test applies, for the same reason: probing a
    // new address with the stored token would hand it to whoever runs that
    // host. A new address brings its own token.
    const tokenSupplied = Boolean(entries.gitToken?.trim());
    if (next.url !== now.url && next.token && !tokenSupplied) {
      return settings.sourceOf('gitToken') === 'env'
        ? refuse({
            kbRepoUrl:
              'The access token is set by the GIT_TOKEN environment variable and is only used with the repository it was set for — change both there.',
          })
        : refuse({ gitToken: TOKEN_FOR_THAT_REPOSITORY });
    }

    // Nothing to prove without both halves: a first save of the address alone
    // cannot finish setup, and the save that later brings the token is probed.
    if (!next.url || !next.token) return true;

    const changesConnection =
      next.url !== now.url || next.token !== now.token || next.username !== now.username;
    const completesSetup =
      !wasComplete &&
      validateBranchModel({
        defaultBranch: after('defaultBranch'),
        protectedBranches: after('protectedBranches'),
      }) === null;
    if (!changesConnection && !completesSetup) return true;

    const check = await checkConnection(next);
    if (check.outcome === 'connected') return true;
    return refuse({ [check.field]: check.error });
  }

  /**
   * A SAVED SIGN-IN CONFIGURATION IS ONE THE PROVIDER HAS NOT TURNED DOWN.
   *
   * Without this an issuer that is not one, or a secret with a typo, saves as
   * well as a working configuration, and the first news of it is the sign-in
   * button failing for someone else after the restart.
   *
   * The same gate rule as the repository connection: checked on the values
   * the save WOULD put in effect, and only when the save changes the issuer,
   * the application id or the secret. Scopes, the button label, the allowed
   * domains and everything outside single sign-on are never probed.
   *
   * A definitive refusal answers 400 with the problem on its field and returns
   * null. Otherwise it returns what the save should record — verified, or
   * unverified when the provider's answer said nothing definite — or no record
   * when nothing about the configuration was proven.
   */
  async function signInHoldsFor(
    entries: Record<string, string>,
    res: express.Response,
  ): Promise<{
    record?: { state: 'verified' | 'unverified'; credentials: OidcCredentials };
  } | null> {
    const after = settings.resolveAfter(entries);
    const now = settings.resolveOidcCredentials();
    const next: OidcCredentials = {
      issuerUrl: normalizeIssuerUrl(after('oidcIssuerUrl')),
      clientId: after('oidcClientId'),
      clientSecret: after('oidcClientSecret'),
    };
    const refuse = (problems: Record<string, string>) => {
      res.status(400).json({ error: Object.values(problems)[0], problems });
      return null;
    };
    const changes =
      next.issuerUrl !== now.issuerUrl ||
      next.clientId !== now.clientId ||
      next.clientSecret !== now.clientSecret;
    if (!changes) return {};

    // THE CONFIGURED SECRET ONLY EVER GOES TO THE CONFIGURED PROVIDER: probing
    // a new issuer with it would hand it to whoever runs that one.
    const secretSupplied = Boolean(entries.oidcClientSecret?.trim());
    if (next.issuerUrl !== now.issuerUrl && next.clientSecret && !secretSupplied) {
      return settings.sourceOf('oidcClientSecret') === 'env'
        ? refuse({
            oidcIssuerUrl:
              'The application secret is set by the OIDC_CLIENT_SECRET environment variable and is only sent to the provider it was set for — change both there.',
          })
        : refuse({ oidcClientSecret: SECRET_FOR_THAT_PROVIDER });
    }

    // Nothing to prove until all three are there; the save that completes
    // them is the one probed.
    if (!next.issuerUrl || !next.clientId || !next.clientSecret) return {};

    const check = await checkOidc({ ...next, redirectUri: oidcRedirectUri });
    if (check.outcome === 'rejected') return refuse({ [check.field]: check.error });
    return { record: { state: check.outcome, credentials: next } };
  }

  /**
   * "Test sign-in configuration": the same check the save runs, BEFORE
   * anything is saved, on the values typed — falling back to those in effect.
   *
   * Answers 200 with `outcome` whenever the check ran: `verified`,
   * `unverified` (the issuer is fine, the credentials could not be judged),
   * `issuer-verified` (no application id or secret to try yet) or `rejected`
   * with the field it is about. A 400 is a request that never got as far as
   * asking. Never returns or logs the secret.
   */
  router.post('/setup/test-oidc', requireAdmin, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const supplied = (key: string): string | null => {
      const value = body[key];
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };
    const current = settings.resolveOidcCredentials();
    const issuerUrl = normalizeIssuerUrl(supplied('oidcIssuerUrl') ?? current.issuerUrl);
    if (!issuerUrl) {
      res.status(400).json({ ok: false, error: 'Enter the provider address first.' });
      return;
    }
    const issuerProblem = settings.definitions.find((d) => d.key === 'oidcIssuerUrl')?.validate?.(issuerUrl);
    if (issuerProblem) {
      res.status(400).json({ ok: false, outcome: 'rejected', field: 'oidcIssuerUrl', error: issuerProblem });
      return;
    }
    const clientId = supplied('oidcClientId') ?? current.clientId;
    const suppliedSecret = supplied('oidcClientSecret');
    // The stored secret is sent only to the issuer it was saved for; testing
    // another one brings its own. Without it, only the issuer is checked.
    const clientSecret = suppliedSecret ?? (issuerUrl === current.issuerUrl ? current.clientSecret : '');
    if (!suppliedSecret && issuerUrl !== current.issuerUrl && current.clientSecret && clientId) {
      res.status(400).json({
        ok: false,
        outcome: 'rejected',
        field: 'oidcClientSecret',
        error: SECRET_FOR_THAT_PROVIDER,
      });
      return;
    }

    try {
      if (!clientId || !clientSecret) {
        const issuer = await checkIssuer(issuerUrl);
        if (issuer.outcome !== 'verified') {
          res.json({ ok: false, outcome: 'rejected', field: issuer.field, error: issuer.error });
          return;
        }
        res.json({ ok: true, outcome: 'issuer-verified' });
        return;
      }
      const tested: OidcCredentials = { issuerUrl, clientId, clientSecret };
      const check = await checkOidc({ ...tested, redirectUri: oidcRedirectUri });
      if (check.outcome === 'rejected') {
        res.json({ ok: false, outcome: check.outcome, field: check.field, error: check.error });
        return;
      }
      // Proving the configuration in effect is as good as signing in with it.
      // A save landing while this check ran is harmless: the record is keyed
      // by the values tested, so it never speaks for the ones saved since.
      const testsCurrent =
        tested.issuerUrl === current.issuerUrl &&
        tested.clientId === current.clientId &&
        tested.clientSecret === current.clientSecret;
      if (check.outcome === 'verified' && testsCurrent) {
        await settings.recordOidcVerification('verified', tested);
      }
      res.json({
        ok: check.outcome === 'verified',
        outcome: check.outcome,
        ...(check.outcome === 'unverified' ? { error: check.error } : {}),
        oidcVerification: await settings.oidcVerification(),
      });
    } catch (err) {
      console.error('[setup] sign-in check failed:', err instanceof Error ? err.message : String(err));
      res.status(500).json({ ok: false, error: 'Could not run the sign-in check.' });
    }
  });

  /**
   * Try the credentials against the real remote, BEFORE anything is saved.
   *
   * This is the reason the screen is worth more than the environment variables
   * it replaces: it proves the URL resolves, the token authenticates, the
   * username is the one this host expects, AND that the token may push — in a
   * few seconds instead of as a failed clone or a failed save at some later,
   * unrelated moment. It runs the same check the save does.
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
      res.status(400).json({ ok: false, outcome: 'rejected', error: TOKEN_FOR_THAT_REPOSITORY });
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

    let check: ConnectionCheck;
    try {
      check = await checkConnection({ url, token, username });
    } catch (err) {
      // The check answers every refusal it can read as an outcome; a throw is
      // the check itself breaking. Logged scrubbed — git failures have been
      // known to quote the credential back — and returned generic.
      const raw = err instanceof Error ? err.message : String(err);
      log.error(`connection check failed: ${redactSecret(raw, [token, ...urlQuerySecrets(url)])}`);
      res.status(500).json({ ok: false, error: 'Could not run the connection check.' });
      return;
    }
    if (check.outcome === 'rejected') {
      // 200: the check RAN and the host said no. A 4xx is for a request that
      // never got as far as asking.
      res.json({ ok: false, outcome: check.outcome, field: check.field, error: check.error });
      return;
    }
    /**
     * The repository's top-level folders on the branch it serves, so the
     * screen can say whether each configured root is there — and catch the
     * `skills/` a `Skills` setting would silently scaffold a twin beside.
     * Listed for a read-only token too: it reads, and the folder advice holds
     * whatever permission it is granted next. An empty repository has no
     * tree: an empty list, not a lookup. A listing that fails is null — never
     * a failed connection.
     */
    const listingBranch = pickListingBranch(
      check.defaultBranch,
      supplied('defaultBranch') ?? (settings.resolve('defaultBranch') || null),
      check.branches,
    );
    const rootFolders = check.empty
      ? []
      : listingBranch
        ? await listFolders({ url, branch: listingBranch, username, token })
        : null;
    res.json({
      // Only read AND write is "connected" — a read-only token is refused
      // on save, so the button must not call it a success.
      ok: check.outcome === 'connected',
      outcome: check.outcome,
      ...(check.outcome === 'read-only' ? { field: check.field, error: check.error } : {}),
      // An EMPTY repository is a success, not a failure — seeding one is a
      // supported path, and saying "no branches yet" beats an error that
      // reads like the credentials are wrong.
      empty: check.empty,
      branches: check.branches,
      defaultBranch: check.defaultBranch,
      rootFolders,
    });
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
