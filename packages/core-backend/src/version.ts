/**
 * The git commit the running build was produced from, surfaced by
 * `GET /api/health` so the deploy pipeline can confirm a staging/production
 * rollout by sha *before* smoke-testing it.
 *
 * Sources, in priority order:
 *  - `GIT_SHA` — baked at image build time via the Dockerfile `ARG`/`ENV`
 *    (set from `git rev-parse HEAD` by CI or `docker compose build`).
 *  - `SOURCE_COMMIT` — Coolify injects this for git-based deploys, so the
 *    sha is correct on hosted deploys even when no explicit build arg was
 *    passed. `.git` is in `.dockerignore`, so the sha can't be derived
 *    inside the build — it has to be passed in.
 *  - `'unknown'` — local `tsx` runs and any build that wired neither.
 */
export function resolveGitSha(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GIT_SHA || env.SOURCE_COMMIT || '').trim() || 'unknown';
}

export const GIT_SHA = resolveGitSha();
