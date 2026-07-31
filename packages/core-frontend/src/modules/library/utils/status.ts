import type { ToolSecrets, ToolVarStatus } from '../../secrets-vault/services/tool-secrets.api';

/**
 * Status derivation for the Library. Everything the cards, gems and loadout
 * rows show is computed from the secrets-vault browser surface
 * (`GET /api/secrets/tools` — see `tool-secrets.api.ts`), which exposes per
 * variable: adminConfigured / userConfigured / oauth / authorized /
 * needsReauth, plus per-tool `canWrite`. Design rule from the approved mock:
 * status is only shown when something needs attention — healthy items render
 * clean.
 */

export type GemState = 'ok' | 'warn' | 'err' | 'off';

export interface AttentionStatus {
  state: GemState;
  /** User-facing state line (glossary-compliant plain words). */
  text: string;
}

const OK: AttentionStatus = { state: 'ok', text: 'Connected' };

/** Severity order for aggregation: broken sign-in > not set up > user action pending. */
const RANK: Record<GemState, number> = { ok: 0, warn: 1, off: 2, err: 3 };

function varStatus(v: ToolVarStatus, canWrite: boolean): AttentionStatus {
  if (v.oauth) {
    if (!v.adminConfigured) {
      return {
        state: 'off',
        text: canWrite ? 'Not set up yet — you maintain this integration' : 'Not set up yet',
      };
    }
    if (v.authorized && v.needsReauth) return { state: 'err', text: 'Sign in again to keep this working' };
    if (!v.authorized) return { state: 'warn', text: 'Needs your sign-in' };
    return OK;
  }
  if (v.scope === 'user') {
    return v.userConfigured ? OK : { state: 'warn', text: 'Needs a key from you' };
  }
  return v.adminConfigured
    ? OK
    : {
        state: 'off',
        text: canWrite ? 'Not set up yet — you maintain this integration' : 'Not set up yet',
      };
}

/** Aggregate connection state of one integration for the current user. */
export function toolStatus(tool: ToolSecrets): AttentionStatus {
  let worst = OK;
  for (const v of tool.variables) {
    const s = varStatus(v, tool.canWrite);
    if (RANK[s.state] > RANK[worst.state]) worst = s;
  }
  return worst;
}

/** Per-variable status rows for the integration detail dialog. */
export function toolVariableStatuses(tool: ToolSecrets): { v: ToolVarStatus; status: AttentionStatus }[] {
  return tool.variables.map((v) => ({ v, status: varStatus(v, tool.canWrite) }));
}

/**
 * Which integrations a skill needs, derived from the skill's `allowed-tools`
 * frontmatter. Entries are agent tool names, typically namespaced by the
 * manual (`slack_post_message`, `slack.slack_post_message`) or the bare manual
 * name; generic agent tools (`Bash`, `Read`) match no manual and are ignored.
 * Best-effort by design — there is no dedicated skill→integration link in the
 * backend contract today.
 */
export function neededToolsFor(
  skill: { allowedTools?: string[] },
  tools: ToolSecrets[],
): ToolSecrets[] {
  const entries = (skill.allowedTools ?? []).map((e) => e.toLowerCase());
  if (entries.length === 0) return [];
  return tools.filter((t) => {
    const n = t.name.toLowerCase();
    return entries.some((e) => e === n || e.startsWith(`${n}_`) || e.startsWith(`${n}.`));
  });
}

/** A skill is ready when every integration it needs is fully connected. */
export function skillStatus(neededTools: ToolSecrets[]): AttentionStatus {
  const broken = neededTools.some((t) => toolStatus(t).state !== 'ok');
  return broken ? { state: 'warn', text: 'Needs setup' } : { state: 'ok', text: 'Ready' };
}

/* ── gallery filtering ── */

export type LibraryCategory = 'skills' | 'integrations' | 'owned';

export interface LibraryFilterable {
  kind: 'skill' | 'integration';
  name: string;
  description: string;
  owned: boolean;
}

/** The chip + search filter from the mock: category narrows, query matches name/description. */
export function filterLibraryItems<T extends LibraryFilterable>(
  items: T[],
  category: LibraryCategory,
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return items.filter((item) => {
    if (q && !item.name.toLowerCase().includes(q) && !item.description.toLowerCase().includes(q)) {
      return false;
    }
    if (category === 'skills') return item.kind === 'skill';
    if (category === 'integrations') return item.kind === 'integration';
    return item.owned;
  });
}
