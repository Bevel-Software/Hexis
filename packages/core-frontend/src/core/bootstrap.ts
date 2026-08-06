import { configureBranchModel, validateBranchModel } from '@bevel-software/platform-shared';

/** What `GET /api/config` serves. Unauthenticated — see the route's comment. */
interface ServerConfig {
  branchModel: { defaultBranch: string; protectedBranches: string[] };
}

/**
 * Fetch the deployment's configuration and apply it, BEFORE React renders.
 *
 * The branch model used to be baked into this bundle at build time (Vite
 * `define` over `process.env.DEFAULT_BRANCH`), which meant one artifact per
 * deployment and a rebuild to rename a branch. It now arrives from the server
 * — but it has to arrive before any component body reads `DEFAULT_BRANCH`,
 * which is why this is awaited by the entry point rather than done in an
 * effect. A component that rendered first would read an empty string and
 * build URLs pointing at a branch called nothing.
 *
 * Unauthenticated by necessity: the login screen and the router are on the
 * near side of having a session.
 */
export async function loadServerConfig(): Promise<void> {
  // No "already configured?" short-circuit: applying the same model twice is a
  // no-op, `configureBranchModel` only rejects an INVALID one, and the guard
  // made this function unobservable once anything had configured the module —
  // including its own tests.
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`Could not load configuration (${res.status})`);
  const config = (await res.json()) as ServerConfig;
  /**
   * An UNCONFIGURED deployment is not a failure — it is the state the setup
   * screen exists for. A fresh install has no branch model yet, and
   * `configureBranchModel` throws on an empty one, so applying it blindly
   * turned first-run into "this deployment is not responding" and put the
   * screen that fixes it on the far side of the error.
   *
   * Leaving the model unset is safe because nothing that reads it renders
   * until `SetupGate` opens: the login screen does not use it, and everything
   * that does is behind the gate, which stays shut until the branch model is
   * among the settings that make setup complete.
   */
  const problem = validateBranchModel(config.branchModel);
  if (!problem) configureBranchModel(config.branchModel);
}

/**
 * What to show when the above fails.
 *
 * Deliberately NOT a React tree: the failure means the app cannot be
 * configured, so mounting it to explain that would be mounting the thing that
 * does not work. Plain DOM, no dependencies, and it says the one useful thing —
 * this is the server's problem, not yours.
 */
export function renderConfigFailure(root: HTMLElement, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  root.textContent = '';
  const wrap = document.createElement('div');
  wrap.setAttribute('role', 'alert');
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'height:100vh;gap:.5rem;font-family:system-ui,sans-serif;color:#334155;padding:1.5rem;text-align:center';
  const title = document.createElement('h1');
  title.textContent = 'This deployment is not responding';
  title.style.cssText = 'font-size:1.125rem;font-weight:600;margin:0';
  const body = document.createElement('p');
  body.textContent = 'The server could not be reached for its configuration. Try again shortly.';
  body.style.cssText = 'margin:0;font-size:.875rem';
  const small = document.createElement('p');
  small.textContent = detail;
  small.style.cssText = 'margin:0;font-size:.75rem;color:#94a3b8';
  wrap.append(title, body, small);
  root.append(wrap);
}
