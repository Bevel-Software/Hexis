import { authFetch } from '../../../lib/api';

/** Mirrors the backend shape in `update-check.service.ts`. */
export interface UpdateCheckResult {
  updateAvailable: boolean;
  current: string;
  latest?: string;
  notesUrl?: string;
}

/**
 * Ask the server whether a newer release exists. Every failure — network,
 * 403, a disabled check — is "no update": the banner is a courtesy, and a
 * courtesy never renders an error state.
 */
export async function fetchUpdateCheck(): Promise<UpdateCheckResult> {
  try {
    const res = await authFetch('/api/update-check');
    if (!res.ok) return { updateAvailable: false, current: '' };
    return (await res.json()) as UpdateCheckResult;
  } catch {
    return { updateAvailable: false, current: '' };
  }
}
