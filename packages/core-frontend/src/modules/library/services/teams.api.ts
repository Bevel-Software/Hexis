import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';
import type { TeamAccess } from '../utils/status';

export type { TeamAccess } from '../utils/status';

/**
 * What each team can use — `GET /api/teams`, one entry per group of the
 * active group source, sliced to what the caller already sees. Ids only;
 * the Library joins them onto its own catalog.
 */
export async function listTeams(): Promise<TeamAccess[]> {
  const data = await handleApiResponse<{ teams: TeamAccess[] }>(await authFetch('/api/teams'));
  return data.teams;
}
