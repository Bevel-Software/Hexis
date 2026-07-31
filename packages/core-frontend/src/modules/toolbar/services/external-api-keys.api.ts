import { authFetch } from '../../../lib/api';

export interface ExternalApiKeySummary {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** Model-proxy usage for this key today + the daily cap (in tokens). */
  llmUsage?: { usedTodayTokens: number; dailyTokenCap: number };
}

export interface MintedExternalApiKey {
  plaintext: string;
  summary: ExternalApiKeySummary;
}

async function unwrap(res: Response, fallback: string): Promise<never> {
  let serverError: string | undefined;
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === 'string' && body.error.length > 0) {
      serverError = body.error;
    }
  } catch {
    // Non-JSON error body — fall through.
  }
  throw new Error(serverError ?? fallback);
}

export async function listExternalApiKeys(): Promise<ExternalApiKeySummary[]> {
  const res = await authFetch('/api/mcp/external-api-keys');
  if (!res.ok) await unwrap(res, "Couldn't load external API keys.");
  return res.json() as Promise<ExternalApiKeySummary[]>;
}

export async function createExternalApiKey(label: string): Promise<MintedExternalApiKey> {
  const res = await authFetch('/api/mcp/external-api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) await unwrap(res, "Couldn't create external API key.");
  return res.json() as Promise<MintedExternalApiKey>;
}

export async function disconnectExternalApiKey(id: string): Promise<void> {
  const res = await authFetch(`/api/mcp/external-api-keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) await unwrap(res, "Couldn't disconnect this key.");
}

/**
 * Permanently delete a disconnected key (drops its audit row). The backend
 * refuses to delete a still-active key, so callers should only offer this on
 * rows that are already disconnected.
 */
export async function deleteExternalApiKey(id: string): Promise<void> {
  const res = await authFetch(
    `/api/mcp/external-api-keys/${encodeURIComponent(id)}/permanent`,
    { method: 'DELETE' },
  );
  if (!res.ok) await unwrap(res, "Couldn't delete this key.");
}
