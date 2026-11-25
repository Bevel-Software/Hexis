import type { Verb } from '@bevel-software/platform-shared';

/**
 * What each access verb lets someone do, in eight words or fewer, under the
 * name the app shows for it. Shown as a muted line under the verb inside an
 * opened verb picker and under the request choices, and carried as the
 * accessible description of those picker items, the request radios, the verb
 * summary of a row the reader cannot change, and the Library's Owner pill.
 *
 * Each line is the resolver's own table (`VERB_REQUIRES` in platform-shared)
 * and the gates that read it: edit and download each include read, edit does
 * not include download, owner includes both; approving change requests and
 * changing who has access are gated on write; owners are the people named to
 * ask about it.
 */
export const VERB_HELP = {
  read: 'Open and read it',
  write: 'Read, change, approve changes, manage access',
  download: 'Read and save a copy',
  owner: 'Edit, download, and be its contact',
} as const satisfies Record<Verb, string>;
