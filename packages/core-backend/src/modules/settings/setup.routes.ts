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
  isDefaultKbLayout,
  validateBranchModel,
  validateKbLayout,
} from '@bevel-software/platform-shared';
import type { KbContext } from '../../shared/kb-context.js';
import { failureOf, type GitFailure } from '../../shared/git-failure.js';
import { redactSecret, urlQuerySecrets } from '../../shared/redact-secret.js';
import { listRootFolders, pickListingBranch } from './git-root-folders.js';
import { sameRepository } from '../kb-fs/remote-url.js';
import { MANAGED_DEFAULT_BRANCH } from './managed-repository.js';
import { GIT_MODES, type GitHubAppRepository, type RepositorySource } from './repository-source.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

/**
 * What setup needs of the ways a deployment can be given its repository:
 * the source every reader of the repository asks, and the one thing a mode
 * has to have DONE before a save that chooses it may go through.
 */
export interface RepositorySetup {
  source: RepositorySource;
  /** Create the repository the deployment keeps for itself, if it is not there. Never touches one that is. */
  ensureManaged(initialBranch: string): Promise<void>;
  /**
   * The connection to GitHub through a GitHub App. Absent, that way is not
   * offered, and a save that names it is refused.
   */
  githubApp?: Pick<GitHubAppRepository, 'url' | 'answered' | 'prepare' | 'token' | 'permits'>;
}

/** Which name a host expects beside the token when none is configured. */
const DEFAULT_GIT_USERNAME = 'x-access-token';

/** The one rule, in the one wording, for a stored token and a repository it was not saved for. */
const TOKEN_FOR_THAT_REPOSITORY =
  'Enter the access token for that repository — the saved one is only used with the repository it was saved for.';

/** The same rule for the application secret and a provider it was not saved for. */
const SECRET_FOR_THAT_PROVIDER =
  'Enter the application secret for that provider — the saved one is only sent to the provider it was saved for.';

/**
 * The knowledge-base layout as setting keys: the three renameable roots, the
 * guide's file name, and the consent that rides with it — which the KB startup
 * phase reads through a getter, so the completing save puts it in effect along
 * with the names.
 */
const LAYOUT_KEYS: readonly string[] = [
  'knowledgeBaseDir',
  'skillsDir',
  'pluginsDir',
];
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
 * The open change requests, as the repository-change confirmation needs them:
 * how many there are to decide about, and the close the admin may choose.
 *
 * Deliberately narrow — the setup routes never read a request, never write
 * one, and never learn what is in it. Nothing here deletes anything: closing
 * leaves every row where it is.
 */
export interface RepositoryChangeRequests {
  /** How many change requests are open right now. */
  countOpen(): Promise<number>;
  /** Close every open request as "repository replaced", releasing the file locks on their branches. Answers how many closed. */
  closeAsRepositoryReplaced(): Promise<number>;
  /**
   * Run the move with no queued commit being written. The startup phase sets
   * working copies aside and clones them again while the deployment is
   * serving, and a commit worker left running would write into a directory
   * that is being renamed away, or into the fresh clone of a repository the
   * commit was never meant for. Absent (a minimal mount has no worker), the
   * move runs as it is.
   */
  whileCommitsHeld?<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * What the admin is asked to confirm before a save MOVES the deployment to
 * another repository, and what they answered about its open change requests.
 *
 * `keep` — the repository only moved: its branches came along, so the open
 * change requests still mean something and stay open.
 * `close` — it is a different repository: none of those branches is in it,
 * so the requests are closed as "repository replaced" (nothing deleted).
 *
 * What happens to the working copies is not a choice, and is decided by the
 * histories, not by this answer (see the startup phase's
 * `reconcileClonesWithConfiguredRepository`): a copy whose history the new
 * repository holds is pointed at it and kept, unpushed commits included; any
 * other is set aside whole and cloned fresh. Nothing is deleted. The
 * confirmation exists so that work which leaves the app this way does so
 * KNOWINGLY.
 */
export type RepositoryChangeChoice = 'keep' | 'close';

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
   * The knowledge base's context as the running graph holds it: the save
   * that completes setup applies the branch model and the layout to it, so
   * every service reads the admin's answer without a restart.
   */
  kb: KbContext,
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
  /**
   * The ways a deployment can be given its repository. Absent, there is the
   * one there always was: an address and a token, read from the settings.
   */
  repository?: RepositorySetup,
  /**
   * What a change of the knowledge-base repository has to decide about, and
   * what to do when the admin decides to close.
   *
   * Injected because the setup routes must stay free of the workflow module —
   * and a minimal mount (tests, a distribution without change requests) simply
   * has none: the default answers "no open requests", so the confirmation
   * offers no choice it cannot honour.
   */
  changeRequests: RepositoryChangeRequests = { async countOpen() { return 0; }, async closeAsRepositoryReplaced() { return 0; } },
): express.Router {
  const router = express.Router();
  const source = repository?.source;

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
    isComplete(settings, kb, source) && kbInit === null && kbInitInFlight === null && bootFailure() === null;

  /**
   * Which ways of having a repository this deployment offers and which one
   * it is on, for the setup screen. `mode` is the one IN EFFECT, inferred
   * for a deployment that never chose; `chosen` is the one the settings
   * say, which differs from it between a move and the restart the move
   * owes. The screen opens on what was chosen, says a restart is pending
   * when the two differ, and offers the first of `modes` to a deployment
   * that has none. `pinned` names the variable that chose for the
   * deployment, when one did. Nothing at all from a mount without the
   * choice, which the screen reads as the one way there was.
   */
  const repositoryStatus = () =>
    source
      ? {
          repository: {
            mode: source.mode(),
            chosen: source.chosen(),
            ...(settings.sourceOf('gitMode') === 'env' ? { pinned: 'GIT_MODE' } : {}),
            modes: GIT_MODES.filter((mode) => mode !== 'github-app' || repository?.githubApp !== undefined),
          },
        }
      : {};

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
      awaitingRestart: awaitingRestart(settings, kb, source),
      isAdmin: true,
      settings: settings.describe(),
      ...repositoryStatus(),
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
    const body = (req.body ?? {}) as {
      settings?: Record<string, unknown>;
      /** The admin's answer to the repository-change confirmation, when they have given one. */
      confirmRepositoryChange?: unknown;
      /** The count of open change requests that answer was given about. */
      seenOpenChangeRequests?: unknown;
    };
    /** Lets the commit worker go again, once a move has held it. */
    let releaseCommits: (() => void) | undefined;
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
      const wasComplete = isComplete(settings, kb, source);
      // A different question, asked of the GATE: whether anyone is being
      // served. Settings that are answered are not a deployment that works
      // — one whose first clone failed has answered everything and serves
      // nobody.
      const wasServing = kbReady();
      nameBranchesOfManagedRepository(entries);
      if (!(await connectionHoldsFor(entries, wasComplete, res))) return;
      // AFTER the connection check, BEFORE anything is stored. After, because
      // an address the host will not answer for is refused on its own terms
      // and there is then nothing to confirm — nobody should have to agree to
      // losing their working copies only to be told the token was missing.
      // Before, because a refused save must destroy nothing: the check only
      // reads the new address and dry-runs a push to it.
      // Asked only of a deployment that has SERVED on the repository it would
      // leave. A first run whose initialisation failed has answered
      // everything and served nobody: correcting its address is finishing
      // setup, and a question about leaving a repository nobody ever worked
      // on would be a question with nothing behind it.
      const hasServed = wasComplete && kbInit === null;
      const repositoryChange = await repositoryChangeFor(
        entries,
        body.confirmRepositoryChange,
        body.seenOpenChangeRequests,
        hasServed,
        res,
      );
      if (!repositoryChange) return;
      // HELD FROM HERE, before anything is stored. The way chosen takes
      // effect a few lines down, and with it the credential git is handed; a
      // commit worker still running in between would push a queued commit
      // from a working copy of the repository being left, with the
      // credential of the one moved to. Let go in the `finally` below.
      if (repositoryChange.changing) releaseCommits = await holdCommits();
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
      /**
       * How many open change requests this save closed as "repository
       * replaced". Nothing is ever deleted; `keep` leaves them exactly as they
       * are, and answers 0.
       *
       * Closed BEFORE the address is stored, as a PRECONDITION of the save. A
       * close that fails after the address is stored has nowhere to go: the
       * address now matches, so the next save sees no change, asks nothing and
       * never retries — leaving requests open on branches the new repository
       * does not have, and their file locks refusing paths to everybody else,
       * with no way for the admin to put it right. Refusing the save instead
       * destroys nothing: the old address still stands, the working copies are
       * untouched (the phase below never ran), and pressing Save again asks the
       * same question and tries again.
       *
       * The other order of failure — closed, then the save itself fails — is
       * recoverable by the admin, who wanted these requests closed and whose
       * next Save completes the replacement. Closing deletes nothing either
       * way.
       */
      let closedChangeRequests = 0;
      if (repositoryChange.choice === 'close') {
        try {
          closedChangeRequests = await changeRequests.closeAsRepositoryReplaced();
        } catch (err) {
          log.error('the open change requests could not be closed, so the repository was not replaced:', { err });
          res.status(500).json({
            error:
              'The open change requests could not be closed, so the repository was not changed. ' +
              'Nothing was saved and no working copy was touched. Try again.',
          });
          return;
        }
      }
      const saved = await settings.save(entries, req.userId ?? null);
      /**
       * THE WAY CHOSEN TAKES EFFECT ON THIS SAVE, in the two cases where the
       * startup phase below runs for it.
       *
       * A deployment that was not serving has nothing on the mode it had: a
       * first run, one whose initialisation failed, a boot that found its
       * repository unreachable. Pinned there, the way out of a repository
       * that does not work would be closed.
       *
       * And a deployment that WAS serving, when its admin has just confirmed
       * the move. The mode in effect was once held until the next restart, so
       * that the running process never presented one way's credential to
       * another way's repository. That reason is answered differently now:
       * the phase below sets the working copies of the repository that was
       * left aside, under a held commit worker, before anything uses the new
       * credential. And an admin of a hosted workspace has no restart to
       * give, so a move that waited for one never happened.
       *
       * What is left pinned is a save that changes the mode WITHOUT moving
       * the repository, which no path produces today; it keeps the restart.
       */
      if (source && (!wasServing || repositoryChange.changing)) source.takeEffect();
      /**
       * The restart the mode owes is read off the two modes themselves, not
       * off what this save wrote: it is owed for as long as the mode chosen
       * is not the one in effect, whichever save chose it, and no longer
       * once a save chooses the mode in effect back.
       */
      const modePending = source !== undefined && source.chosen() !== source.mode();
      const restartKeys = [
        ...saved.restartKeys.filter((key) => key !== 'gitMode'),
        ...(modePending ? ['gitMode'] : []),
      ];
      const restartRequired = restartKeys.length > 0;
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
      if (!kb.isBranchModelConfigured()) {
        const model = {
          defaultBranch: settings.resolve('defaultBranch'),
          protectedBranches: settings.resolve('protectedBranches'),
        };
        if (!validateBranchModel(model)) {
          kb.applyBranchModel(model);
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
       * setup-time run stands failed (`kbInit`), so a save is the retry.
       *
       * AND on a save that MOVES THE REPOSITORY, complete and healthy or
       * not. That one is not a quiet moment — the gate is open and sessions
       * may be live — but it is the moment the working copies stop belonging
       * to the configured repository, and leaving them until the next restart
       * is what made Save and Retry fail against a repository that was gone.
       * The admin has just confirmed the move, so the phase runs, with the
       * commit worker held for as long as it does, and the app opens on the
       * new repository's content.
       *
       * Never on an ordinary re-save of a complete, healthy setup: with the
       * gate open, sessions may be live and nothing needs doing.
       */
      if (
        (!wasComplete ||
          kbInit !== null ||
          bootFailure() !== null ||
          repositoryChange.changing) &&
        isComplete(settings, kb, source)
      ) {
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
        if (isDefaultKbLayout(kb.layout) || (kbInit !== null && layoutAppliedBySetup)) {
          const layout = settings.resolveKbLayout();
          if (!validateKbLayout(layout)) {
            kb.applyLayout(layout);
            layoutApplied = true;
            layoutAppliedBySetup = true;
          }
        }
        try {
          // One run at a time. The save chain already serializes handlers
          // whole, so no second run can start while one executes; the `??=`
          // is defense in depth should another invoker ever appear.
          // A move runs with the commit worker held (see `holdCommits`
          // above): nothing queued is written while working copies are set
          // aside and cloned again.
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
            source?.credentials.token() ?? '',
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
        awaitingRestart: awaitingRestart(settings, kb, source),
        settings: settings.describe(),
        ...repositoryStatus(),
        oidcVerification: await settings.oidcVerification(),
        // Only on the save that changed the repository, so an ordinary save
        // carries no word about change requests at all.
        ...(repositoryChange.changing
          ? { repositoryChange: { choice: repositoryChange.choice, closedChangeRequests } }
          : {}),
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
    } finally {
      releaseCommits?.();
    }
  }

  /**
   * Stop the commit worker until the function this resolves to is called.
   * The hold the composition root offers runs a piece of work with the
   * worker stopped; a move spans the store, the way taking effect and the
   * startup phase, with refusals in between, so the hold is taken here and
   * let go in the handler's `finally`. A mount without a worker holds
   * nothing.
   */
  function holdCommits(): Promise<() => void> {
    if (!changeRequests.whileCommitsHeld) return Promise.resolve(() => {});
    return new Promise((held, failed) => {
      changeRequests.whileCommitsHeld!<void>(() => new Promise<void>((release) => held(release))).catch(failed);
    });
  }

  /**
   * What this save does to the knowledge-base repository, and whether the
   * admin has said yes to it.
   *
   * A MOVE IS ANY SAVE AFTER WHICH THE DEPLOYMENT READS ANOTHER REPOSITORY
   * than the one it is running on, however it came about: another address,
   * another way of having the repository (managed, GitHub, address and
   * token), another repository on GitHub. So the question is asked of the
   * one thing that knows where the repository is under every way — the
   * repository source — comparing the address IN EFFECT with the one this
   * save would choose. A mount without a source has the one way there
   * always was, and the address is the setting.
   *
   * A move takes the working copies of the repository that is left out of
   * use: one whose history the new repository holds is pointed at it and
   * kept, any other is set aside and cloned fresh. Work that was never
   * pushed leaves the app with a copy that is set aside. That is not
   * something to discover afterwards, so the save is REFUSED (409) until the
   * answer comes back with the admin's decision.
   *
   * Only a real move asks: an address that differs from the one in effect in
   * nothing but its spelling — a trailing slash, a `.git` suffix, the case
   * of the host — is the same repository (see `kb-fs/remote-url.ts`), and so
   * is a first-run save, where no repository is in effect and nothing on
   * disk could be left.
   *
   * Returns null when it has already answered the request.
   */
  async function repositoryChangeFor(
    entries: Record<string, string>,
    confirmation: unknown,
    /** How many open change requests the screen showed when the answer was given, when it says. */
    seenOpenChangeRequests: unknown,
    /** Whether the deployment is serving on the repository in effect. One that never served and has no open request is not asked. */
    hasServed: boolean,
    res: express.Response,
  ): Promise<{ changing: boolean; choice: RepositoryChangeChoice | null } | null> {
    const unchanged = { changing: false, choice: null } as const;
    const after = settings.resolveAfter(entries);
    const now = (source ? source.url() : settings.resolve('kbRepoUrl')).trim();
    const next = (source ? source.url(after) : after('kbRepoUrl')).trim();
    if (now === '' || next === '' || sameRepository(now, next)) return unchanged;
    // The count is what the choice is ABOUT, so it is read here rather than
    // left for the screen to ask for separately: the two questions would
    // otherwise be answered a round trip apart, and the number on screen
    // would be the one from before whatever happened in between.
    const openChangeRequests = await changeRequests.countOpen();
    // An answer stands for the count it was given about. A request opened
    // while the question stood was never offered "close", and the "keep" the
    // screen sends when there is nothing to choose would decide it unasked:
    // the question is put again, with the count as it is now.
    const answered = confirmation === 'keep' || confirmation === 'close';
    const answerIsCurrent = typeof seenOpenChangeRequests !== 'number' || seenOpenChangeRequests === openChangeRequests;
    if (answered && answerIsCurrent) return { changing: true, choice: confirmation };
    // A move all the same, and the phase treats it as one; nobody is asked.
    // Open change requests are themselves proof that the deployment served,
    // whatever `hasServed` says: a move that failed part-way leaves it gated
    // with a failure standing, and the next save must still ask about them.
    if (!answered && !hasServed && openChangeRequests === 0) return { changing: true, choice: null };
    res.status(409).json({
      error: 'This moves the deployment to another repository.',
      repositoryChange: {
        openChangeRequests,
        // The way left and the way moved to, for the screen to name them.
        // Equal when the move is within one way (another address, another
        // repository on GitHub); absent from a mount with one way only.
        ...(source ? { from: source.mode(), to: source.mode(after) } : {}),
      },
    });
    return null;
  }

  /**
   * A repository the deployment keeps for itself is new, and empty, and has
   * no branches for anyone to look up: the branch model is ours to name. It
   * is named only when nobody has — an admin's own answer, or one the
   * environment supplies, stands. Every other mode has a repository that
   * already exists, whose branches are asked for, never guessed.
   */
  function nameBranchesOfManagedRepository(entries: Record<string, string>): void {
    if (!source) return;
    const after = settings.resolveAfter(entries);
    if (source.mode(after) !== 'managed') return;
    if (after('defaultBranch') || after('protectedBranches')) return;
    entries.defaultBranch = MANAGED_DEFAULT_BRANCH;
    entries.protectedBranches = MANAGED_DEFAULT_BRANCH;
  }

  /**
   * The same rule for a repository reached through a GitHub App: a saved
   * connection is one GitHub has accepted for reading and writing, asked
   * with the token git will present, which is the installation's.
   *
   * That token is also what keeps the repository's NAME honest. It is the
   * one part of this connection an admin types, and a name the installation
   * does not reach is refused here by GitHub, not by a list of ours.
   *
   * The repository has just said what it calls its trunk, so a deployment
   * with no branch model is given that one: the same answer the setup
   * screen fills in for a repository reached by its address.
   */
  async function githubConnectionHoldsFor(
    setup: RepositorySetup,
    entries: Record<string, string>,
    after: (key: string) => string,
    wasComplete: boolean,
    res: express.Response,
  ): Promise<boolean> {
    const refuse = (problem: string, field = 'githubRepository') => {
      res.status(400).json({ error: problem, problems: { [field]: problem } });
      return false;
    };
    const app = setup.githubApp;
    if (!app) return refuse('This deployment cannot connect to GitHub through a GitHub App.', 'gitMode');
    if (!app.answered(after)) {
      return refuse(
        after('githubRepository')
          ? 'Connect GitHub before choosing a repository.'
          : 'Choose the repository the knowledge base lives in.',
      );
    }
    const url = app.url(after);
    const unanswered =
      validateBranchModel({ defaultBranch: after('defaultBranch'), protectedBranches: after('protectedBranches') }) !== null;
    // Against what is CHOSEN now, not what is in effect: a repository that
    // was proven by the save that chose it is not proven again by the next.
    const stored = (key: string) => settings.resolve(key);
    const changes = setup.source.chosen() !== 'github-app' || url !== setup.source.url(stored);
    if (!changes && (wasComplete || unanswered)) return true;
    // BEFORE GitHub is asked anything with the installation token: that
    // token reaches every repository the installation covers, and would
    // answer for one the person connecting it could never have written to.
    if (!app.permits(after('githubRepository'), after)) {
      log.warn('a repository was named that the person who connected GitHub could not push to');
      return refuse(
        'Choose a repository your own GitHub account can write to. If this one should be, press “Refresh the list” so it is brought up to date.',
      );
    }
    try {
      await app.prepare({ asked: true });
    } catch (err) {
      log.error('GitHub gave no token for the installation:', { detail: err instanceof Error ? err.message : String(err) });
    }
    const token = app.token();
    if (!token) {
      return refuse('GitHub gave this deployment no access. The app may have been uninstalled: connect it again.', 'gitMode');
    }
    const check = await checkConnection({ url, token, username: DEFAULT_GIT_USERNAME });
    if (check.outcome !== 'connected') {
      return refuse(
        check.outcome === 'read-only'
          ? 'The GitHub App can read that repository but not write to it. Grant it write access to the repository’s contents.'
          : check.reason === 'unreachable'
            ? 'GitHub could not be reached. Try again shortly.'
            : 'The GitHub App cannot reach that repository. Add the repository to the app’s installation on GitHub.',
      );
    }
    if (!after('defaultBranch') && !after('protectedBranches')) {
      const trunk = check.defaultBranch || check.branches[0] || (check.empty ? MANAGED_DEFAULT_BRANCH : '');
      if (trunk) {
        entries.defaultBranch = trunk;
        entries.protectedBranches = trunk;
      }
    }
    return true;
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
    if (repository && repository.source.mode(after) === 'managed') {
      // Nothing to prove to a host: the repository is the deployment's own.
      // What has to hold is that it EXISTS before the save that points
      // everything at it, so a disk that cannot take it refuses the choice
      // instead of failing the first clone.
      try {
        await repository.ensureManaged(after('defaultBranch') || MANAGED_DEFAULT_BRANCH);
        return true;
      } catch (err) {
        log.error('the managed repository could not be created:', { err });
        const problem =
          'The repository could not be created on this deployment’s storage. Check that its backups folder is writable, or connect a repository of your own.';
        res.status(400).json({ error: problem, problems: { gitMode: problem } });
        return false;
      }
    }
    if (repository && repository.source.mode(after) === 'github-app') {
      return githubConnectionHoldsFor(repository, entries, after, wasComplete, res);
    }
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
    // host. A new address brings its own token. Until an address is
    // configured there is no repository the token was "set for": a first-run
    // save that brings the address to a token already present (GIT_TOKEN in
    // the environment, whose field the form cannot even edit) is that token's
    // first and only pairing, not a change of it.
    const tokenSupplied = Boolean(entries.gitToken?.trim());
    // A different SPELLING of the configured address is the same repository,
    // so the stored token is still the token it was saved for: asking for it
    // again over a trailing slash would be a question with no answer.
    if (now.url && !sameRepository(next.url, now.url) && next.token && !tokenSupplied) {
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
    // a new issuer with it would hand it to whoever runs that one. Until an
    // issuer is configured there is no provider it was set for — the save
    // that first names one (beside an OIDC_CLIENT_SECRET the form cannot
    // edit) pairs them.
    const secretSupplied = Boolean(entries.oidcClientSecret?.trim());
    if (now.issuerUrl && next.issuerUrl !== now.issuerUrl && next.clientSecret && !secretSupplied) {
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
    // another one brings its own. With no issuer configured yet it was set for
    // none, so it may be tried with the first. Without a secret, only the
    // issuer is checked.
    const forAnotherIssuer = Boolean(current.issuerUrl) && issuerUrl !== current.issuerUrl;
    const clientSecret = suppliedSecret ?? (forAnotherIssuer ? '' : current.clientSecret);
    if (!suppliedSecret && forAnotherIssuer && current.clientSecret && clientId) {
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
      log.error('sign-in check failed:', { err: err instanceof Error ? err.message : String(err) });
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
export function settingsAnswered(
  settings: DeploymentSettingsService,
  /** What answers for the repository. Absent: an address and a token, the one way there was. */
  source?: Pick<RepositorySource, 'answered'>,
): boolean {
  const kb = source ? source.answered() : Boolean(settings.resolve('kbRepoUrl') && settings.resolve('gitToken'));
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
export function isComplete(
  settings: DeploymentSettingsService,
  kb: Pick<KbContext, 'isBranchModelConfigured'>,
  source?: Pick<RepositorySource, 'answered'>,
): boolean {
  return settingsAnswered(settings, source) && kb.isBranchModelConfigured();
}

/** Answered, but not yet in effect: everything is stored, the process is stale. */
export function awaitingRestart(
  settings: DeploymentSettingsService,
  kb: Pick<KbContext, 'isBranchModelConfigured'>,
  source?: Pick<RepositorySource, 'answered'>,
): boolean {
  return settingsAnswered(settings, source) && !kb.isBranchModelConfigured();
}
