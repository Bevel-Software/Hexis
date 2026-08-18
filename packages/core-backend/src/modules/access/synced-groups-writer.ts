import { EMAIL_REGEX, canonicalEmail, canonicalRoleName, RESERVED_ROLE_NAMES } from './access-control.service.js';

/**
 * Locale-independent code-unit comparator. `localeCompare` would make the
 * "deterministic render" depend on the process's ambient locale/ICU build —
 * two deployments could then disagree on byte order and ping-pong no-op
 * detection.
 */
function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Materializes an external directory's groups into `synced-groups.yaml` — the
 * MACHINE-OWNED group file the access resolver reads in IdP mode.
 *
 * Why a file and not the DB: access resolution is file-based and evaluated at
 * git refs (the merge/push gates depend on it), so group membership must live
 * in the KB repo. Wholesale regeneration (never editing) is what makes the
 * file conflict-free, and git history doubles as the membership audit log.
 *
 * The DIRECTORY ITSELF is not core's business: groups arrive through a
 * {@link SyncedGroupsSource} an overlay provides (e.g. a SCIM mirror fed by
 * Entra/Okta provisioning). Core owns the file format, the rendering rules,
 * and the commit pipeline — the same module that parses the file on the read
 * side (`group-files.ts`) governs what gets written into it.
 *
 * The renderer is a PURE function so its determinism is trivially testable;
 * the writer wraps it with debounce (a provisioning cycle is a burst of many
 * directory pushes — one commit per burst, not per mutation) and no-op
 * detection (unchanged content never commits).
 */

const FILE_HEADER = `# MACHINE-GENERATED from the identity provider's directory — do not edit.
# Membership is managed in the IdP; this file is regenerated wholesale on every
# provisioning push. Manual groups live in groups.yaml (ignored while this file
# exists — its presence IS what puts the deployment in IdP mode).
`;

/** A member of an externally-synced group, as the materializer needs it. */
export interface SyncedGroupMember {
  /** Lowercased primary email — the identity join key; null when the IdP sent none. */
  email: string | null;
  /** Deactivated members stay mirrored upstream but are not materialized. */
  active: boolean;
}

/** A group from the external directory, as the materializer needs it. */
export interface SyncedGroupRecord {
  /** The IdP's own identifier, if it sent one — only used to break sort ties. */
  externalId: string | null;
  displayName: string;
  members: SyncedGroupMember[];
}

/**
 * The seam an overlay implements to feed the materializer: "the current
 * groups in the external directory." Core never learns HOW they got there
 * (SCIM push, API poll, …).
 */
export interface SyncedGroupsSource {
  listGroups(): Promise<SyncedGroupRecord[]>;
}

/**
 * Group names whose characters would corrupt the emitted YAML or collide with
 * entry grammar — same character set `assertSafeRoleDisplayName` refuses for
 * roles, but here the name arrives from the IdP so the group is SKIPPED with
 * a warning instead of erroring (fail-closed: an unrepresentable group grants
 * nothing).
 */
function unsafeNameReason(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (!trimmed) return 'empty name';
  if (/[:#<>]/.test(trimmed)) return "contains ':', '#', '<', or '>'";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) return 'contains control characters';
  if (trimmed.startsWith('-')) return "starts with '-'";
  return null;
}

export interface RenderedSyncedGroups {
  text: string;
  /** Groups/members that could not be materialized, human-readable. */
  warnings: string[];
  /** Groups actually emitted (post-skip). */
  groupCount: number;
}

/**
 * Deterministic render: same directory state → byte-identical file. Groups
 * sort by canonical name (ties by externalId), member emails sort lexically.
 * Excluded from materialization (each with a warning): groups with
 * YAML-unsafe or reserved names, canonical-name duplicates (first wins), and
 * members that are inactive or carry no email (email is the identity join
 * key — a member without one cannot be granted anything).
 */
export function renderSyncedGroupsYaml(groups: SyncedGroupRecord[]): RenderedSyncedGroups {
  const warnings: string[] = [];
  const byCanonical = new Map<string, SyncedGroupRecord>();

  const sorted = [...groups].sort((a, b) => {
    const byName = codeUnitCompare(canonicalRoleName(a.displayName), canonicalRoleName(b.displayName));
    if (byName !== 0) return byName;
    const byExternalId = codeUnitCompare(a.externalId ?? '', b.externalId ?? '');
    if (byExternalId !== 0) return byExternalId;
    // Full-key duplicates: break the tie on membership, then on the RAW
    // display name (same canonical can differ in case/spacing, and the winner
    // of the first-wins dedup below decides the emitted name) — so the bytes
    // never depend on source array order.
    const byMembers = codeUnitCompare(
      a.members.map((m) => `${m.email ?? ''}:${m.active}`).sort(codeUnitCompare).join(','),
      b.members.map((m) => `${m.email ?? ''}:${m.active}`).sort(codeUnitCompare).join(','),
    );
    if (byMembers !== 0) return byMembers;
    return codeUnitCompare(a.displayName, b.displayName);
  });

  for (const group of sorted) {
    const reason = unsafeNameReason(group.displayName);
    if (reason) {
      warnings.push(`group '${group.displayName}' skipped: ${reason} — rename it in the IdP`);
      continue;
    }
    const canonical = canonicalRoleName(group.displayName);
    if (RESERVED_ROLE_NAMES.has(canonical)) {
      warnings.push(
        `group '${group.displayName}' skipped: '${canonical}' is a reserved name — rename it in the IdP`,
      );
      continue;
    }
    const existing = byCanonical.get(canonical);
    if (existing) {
      warnings.push(
        `group '${group.displayName}' skipped: name collides with '${existing.displayName}' — rename one in the IdP`,
      );
      continue;
    }
    byCanonical.set(canonical, group);
  }

  const lines: string[] = [FILE_HEADER.trimEnd(), 'groups:'];
  for (const [, group] of byCanonical) {
    const emails = new Set<string>();
    let skippedMembers = 0;
    let malformedMembers = 0;
    for (const member of group.members) {
      if (!member.active || !member.email) {
        skippedMembers++;
        continue;
      }
      // The directory is UNTRUSTED input: a "email" carrying a newline or
      // entry-grammar characters would corrupt the emitted YAML or inject
      // memberships. Canonicalize and validate before it may become a line.
      // A leading '#' passes the regex but the emitted `- #…` reads back as a
      // comment (stripComment) — the member would silently vanish on the next
      // resolver read, so refuse it here where it at least gets a warning.
      const email = canonicalEmail(member.email);
      if (!EMAIL_REGEX.test(email) || email.startsWith('#')) {
        malformedMembers++;
        continue;
      }
      emails.add(email);
    }
    if (skippedMembers > 0) {
      warnings.push(
        `group '${group.displayName}': ${skippedMembers} member${skippedMembers === 1 ? '' : 's'} not materialized (inactive or no email)`,
      );
    }
    if (malformedMembers > 0) {
      warnings.push(
        `group '${group.displayName}': ${malformedMembers} member${malformedMembers === 1 ? '' : 's'} not materialized (malformed email)`,
      );
    }
    const name = group.displayName.trim();
    if (emails.size === 0) {
      lines.push(`  ${name}: []`);
    } else {
      lines.push(`  ${name}:`);
      for (const email of [...emails].sort(codeUnitCompare)) lines.push(`    - ${email}`);
    }
  }

  return { text: lines.join('\n') + '\n', warnings, groupCount: byCanonical.size };
}

export interface SyncedGroupsWriteResult {
  /** False when the rendered content matched what is already committed. */
  changed: boolean;
  groupCount: number;
  warnings: string[];
}

export interface SyncedGroupsWriterDeps {
  source: SyncedGroupsSource;
  /** Current committed file content, or null when it does not exist yet. */
  readCurrent: () => Promise<string | null>;
  /** Write + commit the new content (the composition root owns the git plumbing). */
  persist: (content: string) => Promise<void>;
  /** Post-commit hook: cache invalidation + change events. */
  onWritten?: (result: SyncedGroupsWriteResult) => void;
  /** Trailing-edge debounce for provisioning bursts. */
  debounceMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_DEBOUNCE_MS = 10_000;

export class SyncedGroupsWriter {
  private timer: NodeJS.Timeout | null = null;
  /** Serializes writes: a mutation landing mid-write queues one follow-up. */
  private inflight: Promise<SyncedGroupsWriteResult> | null = null;
  private rerunWanted = false;

  constructor(private readonly deps: SyncedGroupsWriterDeps) {}

  /**
   * Note a directory mutation; (re)arm the debounce timer. Called on every
   * successful ingress/degress, so a provisioning burst keeps pushing the
   * timer and the write lands once, after the burst goes quiet.
   */
  notifyMutation(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow().catch((err) => {
        this.deps.log?.(
          `[directory-sync] deferred synced-groups write failed: ${err instanceof Error ? err.message : err}`,
        );
      });
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    // Never hold the process open for a pending materialization.
    this.timer.unref?.();
  }

  /** Render + commit immediately (used by the admin "Write now" action too). */
  async writeNow(): Promise<SyncedGroupsWriteResult> {
    if (this.inflight) {
      // A write is running against a snapshot that may predate this call —
      // ask for one follow-up run and share ITS eventual result semantics by
      // awaiting the current one first (callers only need "a write covering
      // my mutation happened"; the follow-up covers it).
      this.rerunWanted = true;
      await this.inflight.catch(() => undefined);
      if (this.inflight) return this.inflight;
    }
    this.inflight = this.runOnce();
    try {
      let result = await this.inflight;
      while (this.rerunWanted) {
        this.rerunWanted = false;
        this.inflight = this.runOnce();
        result = await this.inflight;
      }
      return result;
    } finally {
      this.inflight = null;
    }
  }

  private async runOnce(): Promise<SyncedGroupsWriteResult> {
    const groups = await this.deps.source.listGroups();
    const rendered = renderSyncedGroupsYaml(groups);
    for (const w of rendered.warnings) this.deps.log?.(`[directory-sync] ${w}`);

    const current = await this.deps.readCurrent();
    if (current === rendered.text) {
      return { changed: false, groupCount: rendered.groupCount, warnings: rendered.warnings };
    }
    await this.deps.persist(rendered.text);
    const result: SyncedGroupsWriteResult = {
      changed: true,
      groupCount: rendered.groupCount,
      warnings: rendered.warnings,
    };
    this.deps.onWritten?.(result);
    return result;
  }

  /** Cancel any pending debounce (shutdown/tests). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
