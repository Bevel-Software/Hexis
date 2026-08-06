/**
 * Bootstraps the KB *remote* so the rest of the app's assumption — that the KB
 * repo it clones already carries the protected branches and base scaffolding —
 * holds even for a brand-new (or partially-populated) GitHub repo.
 *
 * The platform used to require the KB remote to have been forked from the
 * standalone `knowledge-base-template` repo. That template now ships inside the
 * platform (`kb-template/` at the repo root) and this service seeds from it.
 */
export interface IKbSeedService {
  /**
   * Ensure the KB remote can be cloned: seed a fully-empty repo, and make sure
   * every protected branch exists as a ref (so `clone -b <branch>` succeeds).
   * Idempotent and single-flight — safe to await before every clone; the real
   * work runs at most once per process.
   *
   * - **Empty remote** → full seed: all template files (incl. the sample
   *   ontology) committed to every protected branch. Uses `ADMIN_EMAIL`
   *   (a repo with no Admin is unusable), otherwise throws.
   * - **Existing remote** → create only the protected branches that don't exist
   *   yet, off an existing one. No file changes here — per-branch base files are
   *   filled in by {@link topUpWorkspace} when a branch is loaded.
   */
  ensureRemoteSeeded(): Promise<void>;

  /**
   * Fill in any missing base scaffolding on the freshly-cloned workspace of the
   * branch a user just loaded, then commit + push it to that branch. Add-only —
   * never overwrites existing files, and never restores the sample ontology.
   * Best-effort: never throws, so a top-up hiccup can't block loading the branch.
   *
   * @param repoDir Absolute path to the checked-out KB clone for `branch`.
   * @param branch  The branch that clone is on (the push target).
   */
  topUpWorkspace(repoDir: string, branch: string): Promise<void>;
}
