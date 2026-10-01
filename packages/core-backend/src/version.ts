import { readFileSync } from 'node:fs';

/**
 * The git commit the running build was produced from, surfaced by
 * `GET /api/health` so the deploy pipeline can confirm a staging/production
 * rollout by sha *before* smoke-testing it.
 *
 * Sources, in priority order:
 *  - `GIT_SHA` — baked into the image by the Dockerfile from its ONE build
 *    arg, `SOURCE_COMMIT` (CI, Coolify and a manual build all pass that
 *    name). Baked under a different name deliberately: a runtime variable
 *    overrides an image ENV of the same name, and `SOURCE_COMMIT` is what
 *    a hosted deployment UI writes at runtime — once as an empty literal
 *    that blanked the real value. Nothing at runtime sets `GIT_SHA`.
 *  - `SOURCE_COMMIT` — the runtime value Coolify injects for git-based
 *    deploys, so a build that was not given the arg still reports a sha.
 *    `.git` is in `.dockerignore`, so the sha can't be derived inside the
 *    build — it has to be passed in.
 *  - `'unknown'` — local `tsx` runs and any build that wired neither.
 */
export function resolveGitSha(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GIT_SHA || env.SOURCE_COMMIT || '').trim() || 'unknown';
}

export const GIT_SHA = resolveGitSha();

/**
 * The RELEASE version of the running build — this package's own `version`
 * field, which the fixed-group release process keeps equal to the deployment's
 * release tag (`v<version>`). This is what the update check compares against
 * the newest published release; the git sha above identifies a build, but two
 * shas can't tell "behind" from "ahead".
 *
 * Read from the packaged `package.json`, one hop up from this module in both
 * layouts (`src/` in-repo and tsx, `dist/` compiled — same trick as
 * `assets.ts`). Lazily and defensively: a build that somehow ships without a
 * readable manifest answers `'unknown'`, which the update check treats as
 * "never announce an update" rather than an error.
 */
export function resolveAppVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' && manifest.version
      ? manifest.version
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
