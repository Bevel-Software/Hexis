import { assertValidBranchName } from '../kb-fs/branch-name.js';

/**
 * Turn whatever a caller POSTed to `/api/sync` into the branches to sync.
 *
 * Pure: no IO, no throwing on foreign shapes. The endpoint is meant to be
 * pointed at by a webhook subscription whose payload the operator does not
 * control, so an unrecognised body must degrade to "sync everything" — the
 * safe answer, and the one an empty pipeline call gets too — never to a 400
 * that makes the host disable the subscription.
 *
 * Recognised shapes:
 *
 *   explicit      `{ "branches": ["main", "ali/x"] }`
 *   azure-devops  `eventType: git.push` → `resource.refUpdates[].name`
 *                 `eventType: git.pullrequest.*` → `resource.targetRefName`
 *                 and `resource.sourceRefName`
 *   github/gitea  `{ "ref": "refs/heads/main" }` (push)
 *   gitlab        `{ "object_kind": "push", "ref": "refs/heads/main" }`
 *
 * Only `refs/heads/*` refs count; a tag push names nothing to sync. A branch
 * name git would refuse is dropped from a provider payload (the host
 * produced it, nothing we can do) but reported for an explicit body, where
 * it is the caller's mistake to fix.
 */
export type SyncPayloadSource = 'explicit' | 'azure-devops' | 'github' | 'gitlab' | 'none';

export interface ParsedSyncPayload {
  source: SyncPayloadSource;
  branches: string[] | 'all';
  /** Explicit-body names git would refuse. Empty for every other source. */
  invalid: string[];
}

const HEADS = 'refs/heads/';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function branchFromRef(ref: unknown): string | null {
  if (typeof ref !== 'string' || !ref.startsWith(HEADS)) return null;
  const name = ref.slice(HEADS.length);
  return isValidBranch(name) ? name : null;
}

function isValidBranch(name: string): boolean {
  try {
    assertValidBranchName(name);
    return true;
  } catch {
    return false;
  }
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * How an invalid explicit entry is echoed back. Only primitives are
 * stringified: `String(obj)` on a JSON object carrying `"toString": 1` throws
 * ("Cannot convert object to primitive value"), which would turn a caller's
 * bad body into our 500.
 */
function describeInvalid(entry: unknown): string {
  if (entry === null) return 'null';
  switch (typeof entry) {
    case 'string':
      return entry.trim() === '' ? '(empty)' : entry;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(entry);
    default:
      return Array.isArray(entry) ? '(array)' : '(object)';
  }
}

export function parseSyncPayload(body: unknown): ParsedSyncPayload {
  if (!isRecord(body)) return { source: 'none', branches: 'all', invalid: [] };

  if ('branches' in body) {
    const raw = body.branches;
    if (!Array.isArray(raw)) return { source: 'explicit', branches: 'all', invalid: [] };
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) {
        invalid.push(describeInvalid(entry));
        continue;
      }
      const name = entry.trim();
      (isValidBranch(name) ? valid : invalid).push(name);
    }
    return { source: 'explicit', branches: unique(valid), invalid };
  }

  // Azure DevOps service hook. `eventType` names the event; the branches sit
  // under `resource` in a per-event shape.
  const eventType = body.eventType;
  if (typeof eventType === 'string' && isRecord(body.resource)) {
    const resource = body.resource;
    if (eventType === 'git.push') {
      const updates = Array.isArray(resource.refUpdates) ? resource.refUpdates : [];
      // A DELETION (new object id all zeros) names its branch too: syncing it
      // is what finds the branch gone and retires the stale clone, instead of
      // leaving it to fail on some unrelated full sync later.
      const branches = updates
        .map((u) => (isRecord(u) ? branchFromRef(u.name) : null))
        .filter((b): b is string => b !== null);
      return { source: 'azure-devops', branches: unique(branches), invalid: [] };
    }
    if (eventType.startsWith('git.pullrequest.')) {
      const branches = [branchFromRef(resource.targetRefName), branchFromRef(resource.sourceRefName)]
        .filter((b): b is string => b !== null);
      return { source: 'azure-devops', branches: unique(branches), invalid: [] };
    }
  }

  // GitLab events all carry `object_kind`. Only a push (or a tag push, which
  // names no branch) is a statement about a ref; anything else with a stray
  // `ref` — a merge request, a pipeline — is not, and takes the "everything"
  // fallback rather than being read as a push of that ref.
  if (typeof body.object_kind === 'string') {
    if (body.object_kind !== 'push' && body.object_kind !== 'tag_push') {
      return { source: 'none', branches: 'all', invalid: [] };
    }
    // A deletion (a push to the null sha) names its branch like any push: the
    // sync finds it gone and retires the clone.
    const branch = branchFromRef(body.ref);
    return { source: 'gitlab', branches: branch ? [branch] : [], invalid: [] };
  }

  // GitHub / Gitea push: `ref` at the top level, no `object_kind`. A deletion
  // (`deleted: true`) names its branch like any push, for the same reason.
  if (typeof body.ref === 'string') {
    const branch = branchFromRef(body.ref);
    return { source: 'github', branches: branch ? [branch] : [], invalid: [] };
  }

  return { source: 'none', branches: 'all', invalid: [] };
}
