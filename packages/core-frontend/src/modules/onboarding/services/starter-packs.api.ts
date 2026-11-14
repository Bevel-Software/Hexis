import { authFetch } from '../../../lib/api';

/**
 * The starter-pack question — `GET /api/onboarding/starter-packs` and
 * `POST /api/onboarding/starter-pack`. MIRRORS the backend's
 * `StarterPacksAnswer` / `StarterPackApplied`
 * (`modules/onboarding/starter-pack.service.ts`).
 */
export interface StarterPackSummary {
  id: string;
  /** The chip's label. */
  name: string;
  description: string;
  order: number;
}

export interface ChosenStarterPack {
  id: string;
  name: string;
  /** The team's own "write your first page" request. */
  firstPagePrompt: string;
  /** The pack's pages still exactly as it wrote them (workspace-relative): placeholders, not pages. */
  starterPages: string[];
}

export interface StarterPacksAnswer {
  /** Ask this person: an admin, nobody has answered, the knowledge base is still new. */
  offered: boolean;
  /** A pack's id, `none` for a skip, or null while unanswered. */
  chosen: string | null;
  packs: StarterPackSummary[];
  chosenPack: ChosenStarterPack | null;
}

export interface StarterPackApplied {
  id: string;
  name: string | null;
  pages: number;
  skills: number;
  /** "Added 4 pages and 4 skills for Engineering." — empty for a skip. */
  summary: string;
}

/** The id that answers "Skip, I'll start from scratch". */
export const SKIP_STARTER_PACK = 'none';

/** A refusal, with the server's own sentence. */
export class StarterPackApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'StarterPackApiError';
    this.status = status;
  }
}

async function errorOf(res: Response, fallback: string): Promise<StarterPackApiError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new StarterPackApiError(typeof body?.error === 'string' ? body.error : fallback, res.status);
}

export async function fetchStarterPacks(): Promise<StarterPacksAnswer> {
  const res = await authFetch('/api/onboarding/starter-packs');
  if (!res.ok) throw await errorOf(res, `starter-packs: ${res.status}`);
  const body = (await res.json()) as Partial<StarterPacksAnswer>;
  return {
    offered: body.offered === true,
    chosen: typeof body.chosen === 'string' ? body.chosen : null,
    packs: Array.isArray(body.packs) ? body.packs : [],
    chosenPack: body.chosenPack ?? null,
  };
}

/** Choose `id` (or {@link SKIP_STARTER_PACK}). Throws {@link StarterPackApiError} with the server's reason. */
export async function chooseStarterPack(id: string): Promise<StarterPackApplied> {
  const res = await authFetch('/api/onboarding/starter-pack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw await errorOf(res, 'Couldn’t add the starter pages. Try again.');
  return (await res.json()) as StarterPackApplied;
}
