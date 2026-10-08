/**
 * The starter-pack question as its callers see it: what the routes ask of
 * the service, and the shapes they answer with. The frontend's
 * `starter-packs.api.ts` MIRRORS the two answer types.
 */

import type { AuthUser } from '@bevel-software/platform-shared';
import type { StarterPackSummary } from './starter-packs.js';

/** `GET /api/onboarding/starter-packs`. */
export interface StarterPacksAnswer {
  /** Whether the caller should be asked: an admin, nothing chosen yet, a knowledge folder still new. */
  offered: boolean;
  /** The recorded answer — a pack's id, or `none` — or null while nobody has answered. */
  chosen: string | null;
  /** The packs to choose from, in chip order. Empty for a member, who is never asked. */
  packs: StarterPackSummary[];
  /** The chosen pack, for the first-page prompt — null when none was (or `none` was). */
  chosenPack: ChosenStarterPack | null;
}

export interface ChosenStarterPack {
  id: string;
  name: string;
  /** The team's own "write your first page" request. */
  firstPagePrompt: string;
  /**
   * The pack's pages that still hold exactly what the pack wrote, as
   * workspace-relative paths — those the caller may read, and no other:
   * placeholders, not pages anyone wrote, so they do not tick "Write your
   * first page".
   */
  starterPages: string[];
}

/** `POST /api/onboarding/starter-pack`. */
export interface StarterPackApplied {
  id: string;
  /** The chosen pack's name; null for `none`. */
  name: string | null;
  /** Pages and skills the commit added — what was absent, not what the pack holds. */
  pages: number;
  skills: number;
  /** What to tell the person: "Added 4 pages and 4 skills for Engineering." Empty for `none`. */
  summary: string;
}

/**
 * What the onboarding routes depend on. `status` answers anyone signed in;
 * `choose` refuses a member (403), a question no longer asked (409) and a
 * pack that does not exist (404) with a `WorkflowDomainError` carrying that
 * status. One failure without a status is read by the route all the same:
 * the batch write's "locked by …" refusal, which it answers as a 409 to
 * try again, since nothing was committed. Any other failure is the
 * route's generic 500.
 */
export interface IStarterPackService {
  status(user: Pick<AuthUser, 'email'>): Promise<StarterPacksAnswer>;
  choose(user: AuthUser, id: string): Promise<StarterPackApplied>;
}
