import { useState, type ReactNode } from 'react';
import { useSetupStatus } from '../hooks/useSetupStatus';
import { keptDraft } from '../utils/kept-draft';
import type { RepositoryStatus } from '../services/setup.api';
import { FirstRunStorage } from './FirstRunStorage';
import { SetupScreen } from './SetupScreen';

/**
 * Whether the deployment is at the very start: no way of having a repository
 * chosen, by the settings or by the environment, and the one that needs no
 * answers on offer. Only then is "where should it live?" the whole question.
 * `chosen` is absent from a server that does not tell it apart from `mode`,
 * which then says the same thing.
 */
function choosingStorage(repository: RepositoryStatus | undefined): repository is RepositoryStatus {
  return (
    !!repository &&
    !repository.pinned &&
    (repository.chosen ?? repository.mode) == null &&
    repository.modes.includes('managed')
  );
}

/**
 * Back from GitHub with what was typed on the full form kept for the trip:
 * the trip started there, and that form is where it is put back.
 */
function backToTheFullForm(): boolean {
  if (!new URLSearchParams(window.location.search ?? '').has('github')) return false;
  const kept = keptDraft(() => false);
  return Object.keys(kept.draft).length > 0 || kept.dropped.length > 0;
}

/**
 * Stands between a signed-in session and the application, and only lets it
 * through once the deployment can reach its knowledge base.
 *
 * WHY IT SITS INSIDE THE AUTH GATE. Setup is not public — it is where a
 * repository URL and an access token are entered. It works on an unconfigured
 * deployment because the bootstrap admin (`ADMIN_EMAIL`) is recognised without
 * consulting `roles.yaml`, so the one person who can finish setup can always
 * sign in even though nothing has been cloned yet.
 *
 * WHY NON-ADMINS GET A DIFFERENT SCREEN RATHER THAN THE APP. Every surface
 * behind here reads from a workspace that cannot exist yet; letting someone in
 * would show them a broken file tree and a stream of failed requests. "Still
 * being set up" is both true and useful, and it does not tell them what is
 * missing — that is the admin's business.
 *
 * A FAILED STATUS CHECK OPENS THE GATE. The check is a guard against an
 * unconfigured deployment, not an authorisation boundary: if it cannot be
 * reached, the app behind it is no less usable than it was, and blocking on a
 * transient network failure would lock everyone out of a working deployment.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  // The status is read the shared way (`useSetupStatus`): only the latest
  // read lands, so a late answer cannot undo what a newer one said.
  const { status, failed, loaded, refresh } = useSetupStatus();
  /** The admin asked for the full form ("Use an address and token") over the storage question. */
  const [fullForm, setFullForm] = useState(backToTheFullForm);

  // Nothing is claimed until the answer is in. Rendering the app here and
  // replacing it a moment later would flash a broken workspace at exactly the
  // people this gate exists to protect from one.
  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-ui text-ink-muted">
        Loading…
      </div>
    );
  }

  if (!status || failed || status.complete) return <>{children}</>;

  if (!status.isAdmin || !status.settings) {
    return (
      <div className="flex h-full items-center justify-center bg-sunken px-6">
        <div className="max-w-[46ch] text-center">
          <h1 className="text-title font-semibold text-ink">Still being set up</h1>
          <p className="mt-2 text-body text-ink-muted">
            An admin is connecting this deployment to the place its knowledge, skills and tools
            will live. It will be ready shortly; try again in a few minutes.
          </p>
        </div>
      </div>
    );
  }

  // A fresh deployment is asked one question first. Everything else, and
  // every deployment past that point, gets the full form as it always has.
  if (!fullForm && choosingStorage(status.repository)) {
    return (
      <FirstRunStorage
        repository={status.repository}
        onSaved={refresh}
        onUseAddressAndToken={() => setFullForm(true)}
      />
    );
  }

  return (
    <SetupScreen
      settings={status.settings}
      sync={status.sync}
      kbInit={status.kbInit}
      oidcVerification={status.oidcVerification}
      repository={status.repository}
      // Sent here from the storage question by "Use an address and token".
      openOn={fullForm ? 'token' : undefined}
      onSaved={refresh}
    />
  );
}
