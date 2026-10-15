import { authFetch } from '../../lib/api';

/**
 * What MCP clients are told about one tool's effect — `GET /api/tool-hints`.
 * Mirrors `ToolReadOnlyEntry` in the backend's `read-only-hints.ts`.
 */
export interface ToolHint {
  name: string;
  /** `platform`: an endpoint of this deployment. `meta`: a feature of the MCP servers. */
  kind: 'platform' | 'meta';
  /** What the tool's own declaration makes it. */
  builtIn: boolean;
  /** The admin's override, or null when there is none. */
  override: boolean | null;
  /** What clients are told. */
  readOnly: boolean;
}

export interface ToolHints {
  /** Whether the signed-in person may change a hint (an admin). */
  canEdit: boolean;
  tools: ToolHint[];
}

export async function fetchToolHints(): Promise<ToolHints> {
  const res = await authFetch('/api/tool-hints');
  if (!res.ok) throw new Error(`Could not load the read-only hints (HTTP ${res.status}).`);
  return res.json();
}

/** Set a tool's override, or remove it with `null`; answers the tool as it now stands. */
export async function setToolReadOnly(name: string, readOnly: boolean | null): Promise<ToolHint> {
  const res = await authFetch(`/api/tool-hints/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ readOnly }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Could not save the override (HTTP ${res.status}).`);
  }
  return res.json();
}
