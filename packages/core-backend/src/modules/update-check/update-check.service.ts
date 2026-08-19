/**
 * In-app update check — the server learns the newest published Hexis release
 * and tells admins when the running deployment is behind (the pattern Immich
 * and Gitea use: a quiet banner, no auto-anything).
 *
 * Deliberate shape:
 *
 *  - LAZY, never on a timer. The first `check()` triggers the fetch; a
 *    deployment nobody looks at makes zero calls. Results are cached (~6h),
 *    concurrent callers share one in-flight request.
 *  - The request goes to api.github.com and carries NOTHING but itself — no
 *    auth token (public repo; this must never hold credentials), no
 *    identifier, no telemetry. `UPDATE_CHECK=false` removes even that.
 *  - FAILURE IS SILENT. Offline and air-gapped deployments must stay quiet,
 *    not broken: a failed fetch is cached briefly (~15min, so a dead network
 *    isn't re-probed per request) and reported as "no update available".
 *  - Only a clean `x.y.z` newer than the running version counts. Prerelease
 *    or malformed tags — and a running version we can't parse — resolve to
 *    "no update" rather than a guess or a throw.
 */

export interface UpdateCheckResult {
  updateAvailable: boolean;
  /** The running version (this build's release version). */
  current: string;
  /** Newest published release, when the check reached GitHub and parsed one. */
  latest?: string;
  /** The release-notes page of that release. */
  notesUrl?: string;
}

const RELEASES_LATEST_URL =
  'https://api.github.com/repos/Bevel-Software/Hexis/releases/latest';
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

/** `v1.2.3` / `1.2.3` → `[1,2,3]`; anything else (prerelease included) → null. */
export function parseReleaseVersion(raw: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Whether `latest` is STRICTLY newer than `current`. Numeric per-part compare
 * (no string compare — `0.10.0` > `0.9.1`). Either side failing to parse is
 * `false`: an answer we can't trust is not an update announcement.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseReleaseVersion(latest);
  const b = parseReleaseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export class UpdateCheckService {
  private cached: { result: UpdateCheckResult; expiresAt: number } | null = null;
  private inFlight: Promise<UpdateCheckResult> | null = null;

  constructor(
    private readonly opts: {
      /** `UPDATE_CHECK` — false means no network, ever. */
      enabled: boolean;
      /** The running release version (see `resolveAppVersion`). */
      currentVersion: string;
      /** Injectable for tests; defaults to global fetch. */
      fetchFn?: typeof fetch;
      /** Injectable for tests; defaults to the GitHub releases endpoint. */
      releasesUrl?: string;
      /** Injectable clock for TTL tests; defaults to Date.now. */
      now?: () => number;
    },
  ) {}

  async check(): Promise<UpdateCheckResult> {
    if (!this.opts.enabled) {
      return { updateAvailable: false, current: this.opts.currentVersion };
    }
    const now = (this.opts.now ?? Date.now)();
    if (this.cached && now < this.cached.expiresAt) return this.cached.result;
    // One request serves every concurrent caller; `finally` clears the slot so
    // the NEXT check after settlement reads the cache (or starts a fresh
    // fetch once the TTL lapses).
    this.inFlight ??= this.fetchAndCache().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchAndCache(): Promise<UpdateCheckResult> {
    const current = this.opts.currentVersion;
    const nowFn = this.opts.now ?? Date.now;
    try {
      const fetchFn = this.opts.fetchFn ?? fetch;
      const res = await fetchFn(this.opts.releasesUrl ?? RELEASES_LATEST_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
      const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
      const latest = tag.replace(/^v/, '');
      const notesUrl = typeof body.html_url === 'string' ? body.html_url : undefined;
      const result: UpdateCheckResult = isNewerVersion(latest, current)
        ? { updateAvailable: true, current, latest, notesUrl }
        : // Equal, older, prerelease or malformed: all "no update". `latest`
          // rides along only when it parsed — a garbage tag is not an answer.
          {
            updateAvailable: false,
            current,
            ...(parseReleaseVersion(latest) ? { latest } : {}),
          };
      this.cached = { result, expiresAt: nowFn() + SUCCESS_TTL_MS };
      return result;
    } catch {
      // Silent by design — no log spam, no error to the UI. The short TTL is
      // what keeps a dead network from being probed on every request.
      const result: UpdateCheckResult = { updateAvailable: false, current };
      this.cached = { result, expiresAt: nowFn() + FAILURE_TTL_MS };
      return result;
    }
  }
}
